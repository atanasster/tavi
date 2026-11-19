import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import { findExecutable } from "@tavi/node-kit";

/**
 * The OS keychain as a home for the credential store's at-rest key.
 *
 * Where one is available — the macOS Keychain through `/usr/bin/security`, a
 * Secret Service (GNOME Keyring, KWallet) through libsecret's `secret-tool`,
 * or Windows Credential Manager in process through `@napi-rs/keyring` — the
 * key can live there, and `credentials.key` holds only a reference to
 * it, so encryption needs no passphrase and no step of its own. Three rules:
 *
 *  - **the key never reaches a command line.** Another account's `ps` shows
 *    every argument, so a key is written through the tool's standard input:
 *    `security -i` reads the command from it, and `secret-tool store` reads the
 *    secret from it. Lookups print it on standard output, read here. Windows
 *    runs no tool at all;
 *  - **an item is never overwritten.** Each key gets an account of its own,
 *    and adding to one that exists is refused rather than replacing it;
 *  - **a tool that does not answer is unavailable.** A locked keyring that
 *    would ask for a password is given a few seconds, then treated as no
 *    keychain at all, and the caller falls back to what it did before.
 *
 * Tests inject an in-memory adapter: none may run these tools, and
 * `TAVI_CREDENTIAL_KEYCHAIN=off` keeps `systemCredentialKeychain` from
 * offering one.
 */
export interface CredentialKeychain {
  /** Which keychain, as `credentials.key` records it: a reference is read back through the same kind. */
  readonly kind: CredentialKeychainKind;
  /** What a message calls it: "the macOS Keychain". */
  readonly label: string;
  /** The secret stored for `account`, or `undefined` when there is none. A keychain that cannot be read throws. */
  get(account: string): Promise<string | undefined>;
  /** Store `secret` for `account`, which has none yet; throws when the keychain refuses or does not answer. */
  add(account: string, secret: string): Promise<void>;
  /** Delete the item stored for `account`; one already gone is not an error. Throws when the keychain refuses or does not answer. */
  delete(account: string): Promise<void>;
}

export type CredentialKeychainKind = "macos" | "libsecret" | "wincred";

export const CREDENTIAL_KEYCHAIN_KINDS: readonly CredentialKeychainKind[] = ["macos", "libsecret", "wincred"];

/** The service every tavi key is stored under; the account tells data directories apart. */
export const CREDENTIAL_KEYCHAIN_SERVICE = "tavi-credential-key";

/** How long a keychain tool may take: past it, a keyring waiting on an unlock prompt counts as unavailable. */
const TOOL_TIMEOUT_MS = 10_000;

const SECURITY = "/usr/bin/security";

/**
 * The keychain new keys go to, or `undefined` where there is none to use:
 * not macOS, Linux or Windows, the tool is not installed, Linux has no session bus for
 * a Secret Service to answer on, or `TAVI_CREDENTIAL_KEYCHAIN=off`. Whether
 * the keychain actually takes a key is only known by trying.
 */
export function systemCredentialKeychain(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CredentialKeychain | undefined {
  if (env["TAVI_CREDENTIAL_KEYCHAIN"]?.trim().toLowerCase() === "off") return undefined;
  if (platform === "darwin") return existsSync(SECURITY) ? credentialKeychainOfKind("macos") : undefined;
  if (platform === "linux") {
    const bus = env["DBUS_SESSION_BUS_ADDRESS"];
    if (bus === undefined || bus.trim() === "") return undefined;
    return onPath("secret-tool", env) === undefined ? undefined : credentialKeychainOfKind("libsecret");
  }
  if (platform === "win32") return credentialKeychainOfKind("wincred");
  return undefined;
}

/**
 * The adapter for a kind a reference names. Reading an existing key does not
 * depend on `TAVI_CREDENTIAL_KEYCHAIN`: turning new keys off must not make an
 * encrypted store unreadable.
 */
export function credentialKeychainOfKind(kind: CredentialKeychainKind): CredentialKeychain {
  if (kind === "wincred") return WINCRED_KEYCHAIN;
  return kind === "macos" ? MACOS_KEYCHAIN : LIBSECRET_KEYCHAIN;
}

/** A keychain account or key as Tavi makes them: lowercase hex, nothing a command line could split or extend. */
const KEYCHAIN_TOKEN = /^[0-9a-f]{16,128}$/;

/**
 * The line `security -i` reads to add a key. `security -i` splits its line on
 * spaces and reads a newline as the next command, so the account and the key
 * are held to hex here, by construction: a caller that passes anything else
 * is refused before any tool runs, not quoted.
 */
export function macosAddCommand(account: string, secret: string): string {
  if (!KEYCHAIN_TOKEN.test(account)) throw new Error("a keychain account must be lowercase hex");
  if (!KEYCHAIN_TOKEN.test(secret)) throw new Error("a keychain key must be lowercase hex");
  return `add-generic-password -s ${CREDENTIAL_KEYCHAIN_SERVICE} -a ${account} -l ${CREDENTIAL_KEYCHAIN_SERVICE} -w ${secret}\n`;
}

const MACOS_KEYCHAIN: CredentialKeychain = {
  kind: "macos",
  label: "the macOS Keychain",
  async get(account) {
    const result = await runTool(SECURITY, ["find-generic-password", "-s", CREDENTIAL_KEYCHAIN_SERVICE, "-a", account, "-w"]);
    // 44 is errSecItemNotFound's exit status.
    if (result.code === 44) return undefined;
    if (result.code !== 0) throw new Error(`security find-generic-password exited ${result.code}: ${result.stderr.trim()}`);
    return result.stdout.trim();
  },
  async add(account, secret) {
    // `security -i` reads the command from standard input, so the key is not in any process's arguments.
    // No `-U`: an existing item is refused, never replaced.
    const result = await runTool(SECURITY, ["-i"], macosAddCommand(account, secret));
    if (result.code !== 0) throw new Error(`security add-generic-password exited ${result.code}: ${result.stderr.trim()}`);
  },
  async delete(account) {
    const result = await runTool(SECURITY, ["delete-generic-password", "-s", CREDENTIAL_KEYCHAIN_SERVICE, "-a", account]);
    if (result.code !== 0 && result.code !== 44) {
      throw new Error(`security delete-generic-password exited ${result.code}: ${result.stderr.trim()}`);
    }
  },
};

const LIBSECRET_KEYCHAIN: CredentialKeychain = {
  kind: "libsecret",
  label: "the Secret Service keyring",
  async get(account) {
    const result = await runTool("secret-tool", ["lookup", "service", CREDENTIAL_KEYCHAIN_SERVICE, "account", account]);
    // `lookup` exits 1 with nothing printed when no item matches.
    if (result.code === 1 && result.stdout.trim() === "") return undefined;
    if (result.code !== 0) throw new Error(`secret-tool lookup exited ${result.code}: ${result.stderr.trim()}`);
    return result.stdout.trim();
  },
  async add(account, secret) {
    // `store` reads the secret from standard input when it is not a terminal.
    const result = await runTool(
      "secret-tool",
      ["store", `--label=${CREDENTIAL_KEYCHAIN_SERVICE}`, "service", CREDENTIAL_KEYCHAIN_SERVICE, "account", account],
      secret,
    );
    if (result.code !== 0) throw new Error(`secret-tool store exited ${result.code}: ${result.stderr.trim()}`);
  },
  async delete(account) {
    // `clear` exits 0 whether or not an item matched.
    const result = await runTool("secret-tool", ["clear", "service", CREDENTIAL_KEYCHAIN_SERVICE, "account", account]);
    if (result.code !== 0) throw new Error(`secret-tool clear exited ${result.code}: ${result.stderr.trim()}`);
  },
};

/** One Credential Manager item, as `@napi-rs/keyring`'s `AsyncEntry` gives it. */
export interface KeyringEntry {
  getPassword(signal?: AbortSignal): Promise<string | null>;
  setPassword(password: string, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}

/**
 * Windows Credential Manager, through `entryOf` (by default
 * `@napi-rs/keyring`'s `AsyncEntry`, loaded on first use): in process, so the
 * key is on no command line. An existing item is refused, never replaced,
 * and a store that does not answer within the timeout is unavailable.
 */
export function wincredKeychain(
  entryOf: (service: string, account: string) => KeyringEntry = keyringEntry,
  timeoutMs = TOOL_TIMEOUT_MS,
): CredentialKeychain {
  const entry = (account: string): KeyringEntry => entryOf(CREDENTIAL_KEYCHAIN_SERVICE, account);
  /**
   * `work` under one deadline: its signal asks the call to stop, and a call
   * already inside Windows, which an abort does not reach, is given up on.
   */
  const bounded = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_settle, fail) => {
      timer = setTimeout(() => {
        controller.abort();
        fail(new Error(`Windows Credential Manager did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([work(controller.signal), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    kind: "wincred",
    label: "Windows Credential Manager",
    async get(account) {
      return (await bounded((signal) => entry(account).getPassword(signal))) ?? undefined;
    },
    async add(account, secret) {
      await bounded(async (signal) => {
        const item = entry(account);
        if ((await item.getPassword(signal)) !== null) throw new Error(`Credential Manager already holds an item for ${account}`);
        await item.setPassword(secret, signal);
      });
    },
    async delete(account) {
      // `false` is "there was none", which is not an error; a failed deletion rejects.
      await bounded((signal) => entry(account).deleteCredential(signal));
    },
  };
}

/** `@napi-rs/keyring`'s entry, its native module loaded only when Windows asks for one. */
function keyringEntry(service: string, account: string): KeyringEntry {
  const { AsyncEntry } = createRequire(import.meta.url)("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
  return new AsyncEntry(service, account);
}

const WINCRED_KEYCHAIN = wincredKeychain();

interface ToolResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a keychain tool with no shell, `input` on its standard input, killed after the timeout (reported as a failure). */
function runTool(command: string, args: readonly string[], input = ""): Promise<ToolResult> {
  return new Promise((settle, fail) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], timeout: TOOL_TIMEOUT_MS, killSignal: "SIGKILL" });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (code === null) fail(new Error(`${command} did not answer (${signal ?? "killed"})`));
      else settle({ code, stdout, stderr });
    });
    // A tool that exits before reading its input closes the pipe: that is its exit status's to report.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** `name`'s path on `PATH`, or `undefined`. */
const onPath = (name: string, env: NodeJS.ProcessEnv): string | undefined => findExecutable(name, { env });
