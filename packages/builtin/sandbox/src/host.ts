import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, release, tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxHostCheck, SandboxHostFacts, SandboxHostPort, SandboxStatus } from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import { requireJob, signalGroup } from "@tavi/child-kit";
import { joinPath, systemEnv, systemPathEntries, wslDenyRoots, wslVersion } from "@tavi/node-kit";

import { helperPath, onPath } from "./paths.js";
import { compile } from "./policy-compile.js";
import { TAVI_BWRAP, nodeReadRoot, srtArgs, srtEnvironment, srtHelpersDirectory } from "./srt-cli.js";

export { TAVI_BWRAP } from "./srt-cli.js";

/**
 * Host detection: what this host has,
 * one live probe of the compiled `sandbox.run` policy, and one answer — a
 * tier with its cause and fix — that `sandbox.run`, MCP stdio servers, the
 * PDF engine's children and `doctor` all read. Lifted from the MCP launcher,
 * whose live check it replaces.
 */

/** Facts about this host the sandbox's failures are read against (tests replace them): the contract's, so a host port carries them. */
export type HostFacts = SandboxHostFacts;

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const readNumber = (path: string): number | undefined => {
  const text = readText(path)?.trim();
  return text === undefined || text === "" ? undefined : Number(text);
};

/** A short command's stdout, or undefined when it fails: never blocks the event loop. */
function output(command: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(command, [...args], { encoding: "utf8", timeout: 5_000 }, (error, stdout) => done(error === null ? stdout : undefined));
  });
}

async function versionOf(binary: string): Promise<string | undefined> {
  const first = (await output(binary, ["--version"]))?.split("\n")[0]?.trim();
  return first === undefined || first === "" ? undefined : first;
}

function osRelease(): HostFacts["distribution"] {
  const text = readText("/etc/os-release");
  if (text === undefined) return undefined;
  const field = (name: string): string | undefined => new RegExp(`^${name}="?([^"\\n]*)"?$`, "m").exec(text)?.[1];
  const id = field("ID");
  if (id === undefined) return undefined;
  const version = field("VERSION_ID");
  return version === undefined ? { id } : { id, version };
}

/** Whether `AF_ALG` (38) can be made, asked of python if there is one; undefined otherwise. */
async function socketFamiliesRestricted(): Promise<boolean | undefined> {
  const python = onPath("python3");
  if (python === undefined) return undefined;
  const answer = (await output(python, ["-I", "-c", AF_ALG_PYTHON]))?.trim();
  return answer === "closed" ? true : answer === "open" ? false : undefined;
}

/** Python that tries `socket(AF_ALG, SOCK_SEQPACKET)` and prints `open` or `closed`. */
const AF_ALG_PYTHON = "import socket\ntry:\n socket.socket(38, 5, 0).close(); print('open')\nexcept OSError: print('closed')";

function cgroupFacts(): Pick<HostFacts, "cgroupV2" | "cgroupControllers"> {
  if (!existsSync("/sys/fs/cgroup/cgroup.controllers")) return { cgroupV2: false };
  const own = /^0::(.*)$/m.exec(readText("/proc/self/cgroup") ?? "")?.[1]?.trim() ?? "/";
  const controllers = (readText(join("/sys/fs/cgroup", own, "cgroup.controllers")) ?? "")
    .trim()
    .split(/\s+/)
    .filter((name) => name !== "");
  return { cgroupV2: true, cgroupControllers: controllers };
}

/** This host's facts, read now. `bwrapPath` is the bubblewrap srt will run (the Tavi-owned copy when setup installed one). */
export async function hostFacts(options: { readonly bwrapPath?: string } = {}): Promise<HostFacts> {
  const platform = process.platform;
  const inContainer =
    existsSync("/.dockerenv") ||
    existsSync("/run/.containerenv") ||
    /docker|containerd|kubepods|lxc/.test(readText("/proc/1/cgroup") ?? "");
  const base = {
    platform,
    inContainer,
    appArmorRestrictsUserNamespaces: readNumber("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === 1,
    userNamespacesDisabled:
      readNumber("/proc/sys/user/max_user_namespaces") === 0 || readNumber("/proc/sys/kernel/unprivileged_userns_clone") === 0,
  };
  if (platform !== "linux") return { ...base, kernelRelease: release() };
  const status = readText("/proc/self/status") ?? "";
  const bounding = /^CapBnd:\s*([0-9a-f]+)$/m.exec(status)?.[1];
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  const bwrapPath = options.bwrapPath ?? (existsSync(TAVI_BWRAP) ? TAVI_BWRAP : onPath("bwrap"));
  const bwrapVersion = bwrapPath === undefined ? undefined : await versionOf(bwrapPath);
  const socat = helperPath("socat");
  const rg = helperPath("rg");
  const wsl = wslVersion("linux", { osrelease: () => readText("/proc/sys/kernel/osrelease") });
  const distribution = osRelease();
  const restricted = await socketFamiliesRestricted();
  const filters = /^Seccomp_filters:\s*(\d+)$/m.exec(status)?.[1];
  return {
    ...base,
    kernelRelease: release(),
    ...(distribution === undefined ? {} : { distribution }),
    lsm: (readText("/sys/kernel/security/lsm") ?? "")
      .trim()
      .split(",")
      .filter((name) => name !== ""),
    seccompAvailable:
      /^Seccomp:\s*\d/m.test(status) && arch !== undefined && existsSync(join(srtHelpersDirectory(), "seccomp", arch, "apply-seccomp")),
    ...(typeof process.geteuid === "function" ? { euid: process.geteuid() } : {}),
    ...(bounding === undefined ? {} : { capSetfcapInBounding: (BigInt(`0x${bounding}`) & (1n << 31n)) !== 0n }),
    ...(bwrapPath === undefined
      ? {}
      : {
          bwrap: {
            path: bwrapPath,
            ...(bwrapVersion === undefined ? {} : { version: bwrapVersion }),
            owner: bwrapPath === TAVI_BWRAP ? ("tavi" as const) : ("distribution" as const),
          },
        }),
    ...definedOnly({ socat, rg, wsl }),
    ...(restricted === undefined ? {} : { socketFamiliesRestricted: restricted }),
    ...(filters === undefined ? {} : { seccompFilters: Number(filters) }),
    ...cgroupFacts(),
  };
}

/** A failure's cause, and what the operator runs to fix it. */
export interface SandboxFailure {
  readonly cause: string;
  readonly fix: string;
}

/** bubblewrap older than 0.5.0 lacks two features srt uses (srt README:567): a warning, never the cause. */
function bwrapTooOld(version: string | undefined): boolean {
  const match = /(\d+)\.(\d+)/.exec(version ?? "");
  if (match === null) return false;
  return Number(match[1]) === 0 && Number(match[2]) < 5;
}

function ubuntuAtLeast(facts: HostFacts, major: number, minor: number): boolean {
  if (facts.distribution?.id !== "ubuntu") return false;
  const [year = 0, month = 0] = (facts.distribution.version ?? "").split(".").map(Number);
  return year > major || (year === major && month >= minor);
}

/**
 * Why the sandbox does not run on a platform other than macOS and Linux, with
 * its fix: on Windows, Tavi inside WSL2, where confined tools work today.
 */
export function unsupportedPlatformFailure(platform: string): SandboxFailure {
  return {
    cause: `the sandbox runs on macOS and Linux, not ${platform}: shell commands, MCP stdio servers and the PDF and video children are refused`,
    fix:
      platform === "win32"
        ? "run Tavi inside WSL2 (wsl --install, then install Tavi in the Linux distribution)"
        : "run Tavi on a Linux or macOS host",
  };
}

/**
 * Why the sandbox did not run, with its fix: from the
 * host's facts, then the probe's own words.
 */
export function classifySandboxFailure(output: string, facts: HostFacts): SandboxFailure {
  const text = output.toLowerCase();
  const setup = "tavi sandbox setup  (prints the one-time sudo block; --apply runs it)";
  if (facts.platform !== "darwin" && facts.platform !== "linux") return unsupportedPlatformFailure(facts.platform);
  if (facts.wsl === 1)
    return { cause: "WSL1 has no Linux kernel namespaces", fix: "move this distribution to WSL2 (wsl --set-version <distro> 2)" };
  if (facts.platform === "linux") {
    const missing = [
      facts.bwrap === undefined ? "bubblewrap" : undefined,
      facts.socat === undefined ? "socat" : undefined,
      facts.rg === undefined ? "ripgrep" : undefined,
    ].filter((name) => name !== undefined);
    if (missing.length > 0)
      return {
        cause: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not installed`,
        fix: `${setup}, or apt install bubblewrap socat ripgrep (dnf install bubblewrap socat ripgrep)`,
      };
    if (facts.seccompAvailable === false)
      return {
        cause: "seccomp is unavailable, or srt ships no filter for this architecture (it ships x64 and arm64)",
        fix: "run on a kernel with seccomp on x64 or arm64; or build srt's filter (gcc, libseccomp-dev) and point seccomp.applyPath at it",
      };
    if (facts.euid === 0 && facts.capSetfcapInBounding === false)
      return {
        cause: "Tavi runs as root without CAP_SETFCAP, which mapping uid 0 needs (Linux 5.12+)",
        fix: "tavi service unit --user <name>  (run Tavi as an ordinary user)",
      };
    if (facts.userNamespacesDisabled)
      return {
        cause: "user namespaces are disabled on this host (user.max_user_namespaces = 0 or kernel.unprivileged_userns_clone = 0)",
        fix: "enable them: sysctl -w user.max_user_namespaces=15000 kernel.unprivileged_userns_clone=1",
      };
  }
  if (text.includes("cap_setfcap"))
    return { cause: "Tavi runs as root without CAP_SETFCAP", fix: "tavi service unit --user <name>  (run Tavi as an ordinary user)" };
  if (text.includes("can't mount proc"))
    return {
      cause: "Tavi runs inside a container that masks /proc, where bubblewrap cannot mount its own",
      fix: "serve --sandbox-nested (an MCP server: --nested), srt's weaker nested mode",
    };
  const namespaces = /namespace|uid map|setting up uid|operation not permitted|permission denied|rtm_newaddr/.test(text);
  // A container first: the host's AppArmor sysctl shows through, but setup cannot reach the host from inside.
  if (namespaces && facts.inContainer)
    return {
      cause: "Tavi runs inside a container that does not let bubblewrap create namespaces (Docker's default seccomp profile blocks them)",
      fix: "run the container with --security-opt seccomp=unconfined (then serve --sandbox-nested if it masks /proc)",
    };
  // Ubuntu 25.04+: bubblewrap set up its namespaces, and srt's seccomp helper was refused inside them.
  if (
    facts.platform === "linux" &&
    facts.bwrap?.owner === "distribution" &&
    ubuntuAtLeast(facts, 25, 4) &&
    text.includes("seccomp") &&
    !/uid map|setting up uid|rtm_newaddr/.test(text)
  ) {
    return { cause: "Ubuntu's bwrap-userns-restrict profile (unpriv_bwrap) denies the capabilities srt's apply-seccomp needs", fix: setup };
  }
  if (namespaces && facts.appArmorRestrictsUserNamespaces)
    return {
      cause: "Ubuntu's AppArmor limits unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns = 1)",
      fix: setup,
    };
  return {
    cause: `the sandbox could not run here: ${output.trim().slice(0, 300) || "it printed nothing"}`,
    fix: "tavi doctor shows the host's facts; tavi sandbox check runs the probe again",
  };
}

/** The host's facts as `doctor` lists them: hard errors refuse the tier, warnings do not. */
export function hostChecks(facts: HostFacts): readonly SandboxHostCheck[] {
  if (facts.platform !== "linux") return [];
  const checks: SandboxHostCheck[] = [];
  const tool = (name: string, path: string | undefined, detail?: string): void => {
    checks.push(
      path === undefined ? { name, ok: false, severity: "error", detail: "not installed" } : { name, ok: true, detail: detail ?? path },
    );
  };
  tool(
    "bwrap",
    facts.bwrap?.path,
    facts.bwrap === undefined
      ? undefined
      : [facts.bwrap.path, facts.bwrap.version, `(${facts.bwrap.owner === "tavi" ? "Tavi's copy" : "distribution"})`]
          .filter((part) => part !== undefined)
          .join(" "),
  );
  tool("socat", facts.socat);
  tool("rg", facts.rg);
  if (facts.bwrap !== undefined && bwrapTooOld(facts.bwrap.version))
    checks.push({
      name: "bwrap version",
      ok: false,
      severity: "warning",
      detail: `${facts.bwrap.version ?? ""} is older than 0.5.0: srt's --die-with-parent-of-parent handling and its mount ordering need 0.5.0`,
    });
  checks.push(
    facts.userNamespacesDisabled
      ? {
          name: "user namespaces",
          ok: false,
          severity: "error",
          detail: "disabled (user.max_user_namespaces = 0 or kernel.unprivileged_userns_clone = 0)",
        }
      : {
          name: "user namespaces",
          ok: true,
          ...(facts.appArmorRestrictsUserNamespaces ? { detail: "kernel.apparmor_restrict_unprivileged_userns = 1" } : {}),
        },
  );
  if (facts.seccompAvailable !== undefined)
    checks.push(
      facts.seccompAvailable
        ? { name: "seccomp", ok: true }
        : { name: "seccomp", ok: false, severity: "error", detail: "unavailable, or no srt filter for this architecture" },
    );
  if (facts.euid === 0)
    checks.push({
      name: "user",
      ok: false,
      severity: "warning",
      detail: "Tavi runs as root; tavi service unit --user <name> runs it as an ordinary user",
    });
  if (facts.socketFamiliesRestricted === false)
    checks.push({
      name: "socket families",
      ok: false,
      severity: "warning",
      detail: "AF_ALG can be created (CVE-2026-31431); run Tavi under the generated unit, which sets RestrictAddressFamilies=",
    });
  else if (facts.socketFamiliesRestricted === true) checks.push({ name: "socket families", ok: true, detail: "AF_ALG refused" });
  // Nothing could try AF_ALG (no python3): said, with the filters Tavi runs under, never left silent.
  else
    checks.push({
      name: "socket families",
      ok: false,
      severity: "warning",
      detail: `not checked: python3 is not installed to try AF_ALG; ${facts.seccompFilters === undefined ? "this kernel does not say which seccomp filters Tavi runs under" : facts.seccompFilters === 0 ? "Tavi runs under no seccomp filter, so other socket families are likely open (CVE-2026-31431); run Tavi under the generated unit, which sets RestrictAddressFamilies=" : `Tavi runs under ${String(facts.seccompFilters)} seccomp filter(s), as the generated unit's RestrictAddressFamilies= adds one`}`,
    });
  if (facts.wsl === 1) checks.push({ name: "WSL", ok: false, severity: "error", detail: "WSL1 has no namespaces; use WSL2" });
  return checks;
}

/**
 * The live probe, run inside the sandbox: each line is one attempt
 * the policy must refuse, and the last proves a Node child still works there
 * (file and timer I/O, a child process: libuv's io_uring fallback).
 */
const PROBE_SCRIPT = `
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [secret, ownerTemporary, readOnly, work, windowsFile] = process.argv.slice(1);
const out = {};
const refused = (name, attempt) => { try { attempt(); out[name] = "allowed"; } catch { out[name] = "denied"; } };
refused("read", () => fs.readFileSync(secret));
// Denied means gone, as bubblewrap's empty folder over /mnt leaves it; any other error is not a refusal to count on.
if (windowsFile) { try { fs.readFileSync(windowsFile); out.windowsDrives = "allowed"; } catch (error) { out.windowsDrives = error.code === "ENOENT" ? "denied" : "failed: " + (error.code ?? error.message); } }
refused("ownerTemporary", () => fs.readFileSync(ownerTemporary));
refused("write", () => fs.writeFileSync(path.join(readOnly, "written.txt"), "x"));
const python = spawnSync("python3", ["-I", "-c", ${JSON.stringify(AF_ALG_PYTHON)}], { encoding: "utf8" });
out.afAlg = python.error !== undefined ? "untried" : python.stdout.trim() === "closed" ? "denied" : python.stdout.trim() === "open" ? "allowed" : "untried";
refused("gitHooks", () => { fs.mkdirSync(path.join(work, ".git", "hooks"), { recursive: true }); fs.writeFileSync(path.join(work, ".git", "hooks", "pre-commit"), "x"); });
const unix = net.createServer();
unix.on("error", () => { out.unixSocket = "denied"; finish(); });
unix.listen(path.join(work, "probe.sock"), () => { out.unixSocket = "allowed"; unix.close(); finish(); });
let pending = 2;
function finish() {
  if ((pending -= 1) > 0) return;
  try {
    fs.writeFileSync(path.join(work, "node-io.txt"), "ok");
    const child = spawnSync(process.execPath, ["-e", "setTimeout(() => process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8')), 10)", path.join(work, "node-io.txt")], { encoding: "utf8" });
    out.node = child.stdout === "ok" ? "works" : "failed: " + (child.stderr || child.status);
  } catch (error) { out.node = "failed: " + error.message; }
  process.stdout.write(JSON.stringify(out));
}
const socket = net.connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
const connected = (result) => { if (out.connect !== undefined) return; out.connect = result; socket.destroy(); finish(); };
socket.on("connect", () => connected("allowed"));
// A sandbox refuses at once; a connect that only times out may have got out to a network that drops it.
socket.on("timeout", () => connected("timed out"));
socket.on("error", () => connected("denied"));
`;

/** A file every Windows install has on its system drive, where WSL mounts it by default. */
const WINDOWS_PROBE_FILE = "/mnt/c/Windows/win.ini";

/** Whether the owner can read `path`: only then does the sandbox failing to read it say anything. */
function ownerReads(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/** What one probe found. */
export interface ProbeResult {
  readonly works: boolean;
  readonly checks: readonly SandboxHostCheck[];
  readonly failure?: SandboxFailure;
}

export interface ProbeOptions {
  /** Where the probe's scratch lives: a directory the owner writes, never one the sandbox reads otherwise. */
  readonly dataDirectory: string;
  /** The person's home, denied to the probe as to every run; the process's own by default. */
  readonly home?: string;
  readonly nested?: boolean;
  readonly bwrapPath?: string;
  readonly timeoutMs?: number;
  readonly facts?: HostFacts;
  /**
   * On WSL2, a file on a Windows drive the probe must not read, `/mnt` being
   * denied as every run denies it; skipped when the owner cannot see it either.
   */
  readonly windowsFile?: string;
  /** Runs srt's CLI (tests replace it): the command, its args, env and cwd; resolves with stdout and stderr. */
  readonly run?: (
    command: string,
    args: readonly string[],
    options: { readonly env: Record<string, string>; readonly cwd: string; readonly timeoutMs: number },
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
}

/** Runs the probe's srt process in its own group, killed whole at `timeoutMs`. Exported for its tests. */
export function runSrt(
  command: string,
  args: readonly string[],
  options: { readonly env: Record<string, string>; readonly cwd: string; readonly timeoutMs: number },
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, [...args], {
      env: options.env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own group to end whole; on Windows, its own Job Object.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    requireJob(child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      signalGroup(child, "SIGKILL");
      fail(new Error(`the sandbox probe did not finish in ${String(options.timeoutMs)} ms\n${stderr}`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      done({ stdout, stderr });
    });
  });
}

/**
 * One live probe of the compiled `sandbox.run` policy shape, through srt's
 * CLI (one process, so the owner's in-process sandbox is never touched): the
 * probe's working folder is writable with its protected names, the person's
 * home, the data directory and the owner's temporary directory are denied.
 */
export async function probeSandbox(options: ProbeOptions): Promise<ProbeResult> {
  const facts = options.facts ?? (await hostFacts(options.bwrapPath === undefined ? {} : { bwrapPath: options.bwrapPath }));
  const platform = facts.platform === "linux" ? "linux" : "darwin";
  const home = options.home ?? homedir();
  // The probe's own folder in the data directory: two probes at once never remove each other's files.
  const directory = join(options.dataDirectory, "sandbox", ".probe", randomUUID());
  const work = join(directory, "work");
  const denied = join(directory, "denied");
  // Readable but not writable: a write refused there is refused because writes are allow-only, not because the folder is hidden.
  const readOnly = join(directory, "read-only");
  const ownerTemporary = join(tmpdir(), `tavi-probe-${randomUUID()}.txt`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  mkdirSync(denied, { recursive: true, mode: 0o700 });
  mkdirSync(readOnly, { recursive: true, mode: 0o700 });
  const secret = join(denied, "secret.txt");
  writeFileSync(secret, "not for the sandbox\n", { mode: 0o600 });
  writeFileSync(ownerTemporary, "not for the sandbox\n", { mode: 0o600 });
  // A file read, not a listing: bubblewrap hides a denied folder under an empty one, which lists fine.
  const windowsFile = options.windowsFile ?? WINDOWS_PROBE_FILE;
  const probeWindows = platform === "linux" && facts.wsl === 2 && ownerReads(windowsFile);
  try {
    const { config } = compile(
      {
        filesystem: {
          denyRead: [home, options.dataDirectory, tmpdir(), ...(probeWindows ? wslDenyRoots() : [])],
          allowRead: [work, readOnly, nodeReadRoot([home, options.dataDirectory]), srtHelpersDirectory()],
          allowWrite: [work],
          protectedNames: [{ root: work, names: [".git/hooks", ".git/config"], rootNames: ["HEAD"] }],
        },
        network: { allow: false },
        resources: { timeoutMs: 0, maxOutputBytes: 0 },
      },
      {},
      platform,
    );
    // The bubblewrap the facts found: Tavi's copy after `tavi sandbox setup`, never the restricted one srt would find on PATH.
    const bwrapPath = options.bwrapPath ?? (facts.bwrap?.owner === "tavi" ? facts.bwrap.path : undefined);
    const settings = {
      ...config,
      ...(options.nested === true ? { enableWeakerNestedSandbox: true } : {}),
      ...(bwrapPath === undefined ? {} : { bwrapPath }),
    };
    const settingsFile = join(directory, "srt.json");
    writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 });
    const env: Record<string, string> = {
      ...systemEnv(),
      PATH: process.env["PATH"] ?? joinPath(systemPathEntries()),
      HOME: work,
      TMPDIR: work,
      LANG: process.env["LANG"] ?? "C.UTF-8",
    };
    let output: { readonly stdout: string; readonly stderr: string };
    try {
      output = await (options.run ?? runSrt)(
        process.execPath,
        srtArgs(settingsFile, env, [
          process.execPath,
          "-e",
          PROBE_SCRIPT,
          secret,
          ownerTemporary,
          readOnly,
          work,
          probeWindows ? windowsFile : "",
        ]),
        { env: srtEnvironment(env), cwd: work, timeoutMs: options.timeoutMs ?? 30_000 },
      );
    } catch (error) {
      const message = errorMessage(error);
      return {
        works: false,
        checks: [{ name: "live probe", ok: false, severity: "error", detail: message.slice(0, 300) }],
        failure: classifySandboxFailure(message, facts),
      };
    }
    let found: Record<string, string>;
    try {
      found = JSON.parse(output.stdout.trim()) as Record<string, string>;
    } catch {
      const said = `${output.stderr}\n${output.stdout}`;
      return {
        works: false,
        checks: [{ name: "live probe", ok: false, severity: "error", detail: said.trim().slice(0, 300) || "it printed nothing" }],
        failure: classifySandboxFailure(said, facts),
      };
    }
    const expect = (name: string, label: string, wanted: string): SandboxHostCheck =>
      found[name] === wanted
        ? { name: label, ok: true }
        : { name: label, ok: false, severity: "error", detail: `${found[name] ?? "no answer"}, expected ${wanted}` };
    const checks: SandboxHostCheck[] = [
      expect("read", "denied read", "denied"),
      ...(probeWindows ? [expect("windowsDrives", "Windows drives", "denied")] : []),
      expect("ownerTemporary", "owner's temporary files", "denied"),
      expect("write", "denied write", "denied"),
      expect("gitHooks", ".git/hooks write", "denied"),
      expect("connect", "network", "denied"),
      expect("node", "Node child", "works"),
      // srt's seccomp filter refuses AF_UNIX on Linux; on macOS Seatbelt filters unix sockets by path instead (srt README:391).
      ...(platform === "linux" ? [expect("unixSocket", "AF_UNIX", "denied")] : []),
    ];
    // srt's filter leaves every other family open: the unit closes them, so an open one is a warning, not a refusal.
    if (platform === "linux") {
      checks.push(
        found["afAlg"] === "denied"
          ? { name: "AF_ALG in the sandbox", ok: true }
          : {
              name: "AF_ALG in the sandbox",
              ok: false,
              severity: "warning",
              detail:
                found["afAlg"] === "allowed"
                  ? "a sandboxed command can create AF_ALG sockets (CVE-2026-31431); run Tavi under the generated unit"
                  : "not tried: python3 is not installed",
            },
      );
    }
    const failed = checks.find((check) => !check.ok && check.severity === "error");
    return failed === undefined
      ? { works: true, checks }
      : {
          works: false,
          checks,
          failure: {
            cause: `the sandbox's live probe found ${failed.name}: ${failed.detail ?? "not as expected"}`,
            fix: "tavi sandbox check runs it again; report it with tavi doctor's output",
          },
        };
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(ownerTemporary, { force: true });
  }
}

/** How long a failed answer stands before `current()` starts a fresh probe: a fixed host needs no restart. */
export const FAILED_PROBE_TTL_MS = 10 * 60_000;

/** Where srt itself is installed: a sandbox that could rewrite it would run unsandboxed next time. */
export function srtInstalledUnder(roots: readonly string[], installed: string = srtHelpersDirectory()): string | undefined {
  return roots.find((root) => installed === root || installed.startsWith(root.endsWith("/") ? root : `${root}/`));
}

export interface SandboxHostOptions extends Omit<ProbeOptions, "facts" | "nested"> {
  /** Folders a sandboxed shell may write (`serve --fs-root`): srt must not be installed in one. */
  readonly writableRoots?: readonly string[];
  /** The owner's own tier is the nested one (`serve --sandbox-nested`); a probe of the other mode answers its caller only. */
  readonly nested?: boolean;
  /** Re-read facts and probe (tests replace them). */
  readonly facts?: () => HostFacts | Promise<HostFacts>;
  readonly probe?: (options: ProbeOptions) => Promise<ProbeResult>;
  readonly now?: () => number;
}

/**
 * The host as a `SandboxHostPort`: facts and the probe at `check()`, the
 * owner's last answer synchronously at `current()`. A failed answer older
 * than `FAILED_PROBE_TTL_MS` starts a fresh probe in the background. A check
 * that throws answers `unavailable` with what it threw, never `checking`
 * forever; of overlapping checks, the latest started is the one kept.
 */
export function createSandboxHost(options: SandboxHostOptions): SandboxHostPort {
  const now = options.now ?? Date.now;
  const ownNested = options.nested === true;
  let last: SandboxStatus = { tier: "checking", checks: [] };
  let settledAt = 0;
  let started = 0;
  let inFlight: Promise<SandboxStatus> | undefined;
  const evaluate = async (nested: boolean): Promise<SandboxStatus> => {
    const facts = await (options.facts ?? (() => hostFacts(options.bwrapPath === undefined ? {} : { bwrapPath: options.bwrapPath })))();
    const mechanism =
      facts.platform === "darwin" ? ("seatbelt" as const) : facts.platform === "linux" ? ("bubblewrap" as const) : undefined;
    const exposedRoot = srtInstalledUnder(options.writableRoots ?? []);
    const factChecks = [
      ...hostChecks(facts),
      ...(exposedRoot === undefined
        ? []
        : [
            {
              name: "srt location",
              ok: false,
              severity: "error" as const,
              detail: `srt is installed under ${exposedRoot}, a folder the sandbox may write`,
            },
          ]),
    ];
    const hard = factChecks.find((entry) => entry.severity === "error" && !entry.ok);
    if (exposedRoot !== undefined) {
      return {
        tier: "unavailable",
        ...(mechanism === undefined ? {} : { mechanism }),
        checks: factChecks,
        cause: `srt is installed under ${exposedRoot}, which a sandboxed command may write: a rewritten srt would run unsandboxed`,
        fix: "install Tavi outside every --fs-root",
      };
    }
    if (mechanism === undefined || hard !== undefined) {
      const failure = classifySandboxFailure("", facts);
      return {
        tier: "unavailable",
        ...(mechanism === undefined ? {} : { mechanism }),
        checks: factChecks,
        cause: failure.cause,
        fix: failure.fix,
      };
    }
    const result = await (options.probe ?? probeSandbox)({ ...options, facts, nested });
    const checks = [...factChecks, ...result.checks];
    return result.works
      ? { tier: nested ? "nested" : "full", mechanism, checks }
      : {
          tier: "unavailable",
          mechanism,
          checks,
          ...(result.failure === undefined ? {} : { cause: result.failure.cause, fix: result.failure.fix }),
        };
  };
  const check = async (asked: { readonly nested?: boolean } = {}): Promise<SandboxStatus> => {
    // The owner's own mode unless the caller asks for the other one.
    const nested = asked.nested ?? ownNested;
    const ticket = nested === ownNested ? (started += 1) : undefined;
    let status: SandboxStatus;
    try {
      status = await evaluate(nested);
    } catch (error) {
      status = {
        tier: "unavailable",
        checks: [{ name: "live probe", ok: false, severity: "error", detail: errorMessage(error) }],
        cause: `the sandbox check failed: ${errorMessage(error)}`,
        fix: "tavi sandbox check runs it again; tavi doctor shows the host's facts",
      };
    }
    // Only the owner's own mode, and only the latest started, becomes `current()`.
    if (ticket !== undefined && ticket === started) {
      last = status;
      settledAt = now();
    }
    return status;
  };
  /** One fresh check of the owner's own mode at a time, started after the caller returns: it never waits for the facts a probe reads. */
  const refresh = (): Promise<SandboxStatus> => {
    inFlight ??= new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => check({ nested: ownNested }))
      .finally(() => (inFlight = undefined));
    // Awaited or raced elsewhere: this only keeps an early rejection from going unhandled.
    inFlight.catch(() => undefined);
    return inFlight;
  };
  return {
    current() {
      if (last.tier === "unavailable" && now() - settledAt > FAILED_PROBE_TTL_MS) void refresh();
      return last;
    },
    recheck(olderThanMs) {
      if (last.tier !== "unavailable" || now() - settledAt <= olderThanMs) return undefined;
      return refresh();
    },
    check,
    facts: async () =>
      await (options.facts ?? (() => hostFacts(options.bwrapPath === undefined ? {} : { bwrapPath: options.bwrapPath })))(),
  };
}
