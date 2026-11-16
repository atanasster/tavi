import { readFileSync } from "node:fs";
import { type KeyObject, createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { TaviError, type BrowserDisplay } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { BrowserContextOptions, LaunchOptions } from "playwright";

/**
 * How the agent's browser presents itself. Sites decide what to show by how a browser looks: Chromium's
 * bundled headless shell announces itself as `HeadlessChrome` in its user
 * agent, and Google Flights answered every search from it with "Oops,
 * something went wrong" while the same search, from the same machine, in a
 * browser that said `Chrome`, listed fares.
 *
 * - **Display.** `headless` (the default) runs the full Chromium in its new
 *   headless mode (`channel: "chromium"`), the same browser as a window, not the
 *   stripped shell; a person sees it only through Tavi's live view. A confined
 *   launch on Linux is the exception: it runs the headless shell
 *   (`confined.ts`), whose user agent this module's override still sets. `headed`
 *   opens a real window, placed off-screen — macOS keeps a sliver of it on
 *   screen, so it is an opt-in (`TAVI_BROWSER_HEADED=1`).
 * - **Identity.** The user agent says `Chrome/<major>.0.0.0` on the host's own
 *   platform, as a desktop Chrome does; locale, `Accept-Language` and timezone
 *   are the operator's.
 * - **Automation tells.** No `--enable-automation` switch (the "controlled by
 *   automated software" bar and `navigator.webdriver`), and Blink's
 *   `AutomationControlled` feature off. The GPU stays on: `--disable-gpu`
 *   breaks WebGL, which fingerprinting scripts probe.
 *
 * Nothing here solves a challenge: a captcha is handed to the person.
 */

export type { BrowserDisplay } from "@tavi/contracts";

/** Opt-in Ed25519 HTTP Message Signatures configuration (RFC 9421 / webbotauth). */
export interface AgentSignatureConfig {
  /** Key identifier (`keyid` parameter in `Signature-Input`, e.g. JWK thumbprint). */
  readonly keyId: string;
  /** Ed25519 private key in PEM (PKCS#8) or raw 32-byte seed (hex or base64/base64url). */
  readonly privateKey: string;
  /** Optional `Signature-Agent` URL identifying the operator's agent key directory. */
  readonly signatureAgent?: string;
  /** Signature validity window in seconds (default 300). */
  readonly ttlSeconds?: number;
}

/** The operator's locale, timezone, and optional signed agent identity. */
export interface BrowserIdentity {
  /** A BCP 47 tag, such as `en-US`. */
  readonly locale?: string;
  /** An IANA zone, such as `Europe/Sofia`. */
  readonly timezoneId?: string;
  /** Opt-in Ed25519 HTTP Message Signatures (RFC 9421 / webbotauth). */
  readonly signature?: AgentSignatureConfig;
}

/** A desktop window's size: pages lay out as they do for a person on a laptop. */
export const BROWSER_VIEWPORT = { width: 1366, height: 860 } as const;

/** Where a headed window is placed: off every screen a desktop has. */
const OFF_SCREEN = "--window-position=-32000,-32000";

/** The launch options for `display`. */
export function launchOptionsFor(display: BrowserDisplay, platform: NodeJS.Platform = process.platform): LaunchOptions {
  return {
    headless: display === "headless",
    // The full browser in new headless mode, not the headless shell.
    ...(display === "headless" ? { channel: "chromium" } : {}),
    args: ["--disable-blink-features=AutomationControlled", ...(display === "headed" ? [OFF_SCREEN] : [])],
    ignoreDefaultArgs: ["--enable-automation"],
    // Chromium's own sandbox, which Playwright leaves off: on macOS it is the boundary, since Chromium
    // cannot start inside srt there. On Linux a confined launch picks its mode (`confined.ts`); an unconfined one
    // (headed, or the sandbox switched off) asks for it too, and falls back with a warning where the host refuses it.
    ...(platform === "darwin" || platform === "linux" ? { chromiumSandbox: true } : {}),
    // The browser's processes never see the operator's signing key, nor where it is kept.
    env: withoutAgentSignatureKey(process.env),
  };
}

/** The environment variables that hold or locate the agent's signing key: never passed to a child process. */
const AGENT_SIGNATURE_KEY_VARIABLES = ["TAVI_AGENT_SIGNATURE_PRIVATE_KEY", "TAVI_AGENT_SIGNATURE_KEY_FILE"] as const;

/** `env` without the agent's signing key variables. */
export function withoutAgentSignatureKey(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !(AGENT_SIGNATURE_KEY_VARIABLES as readonly string[]).includes(name)) kept[name] = value;
  }
  return kept;
}

/** The platform part of a desktop Chrome's user agent, for this host's OS. */
function platformToken(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  if (platform === "win32") return "Windows NT 10.0; Win64; x64";
  return "X11; Linux x86_64";
}

/**
 * A desktop Chrome's user agent for browser `version` (`153.0.8010.12`, as
 * `Browser.version()` reports it): Chrome itself reduces the version to its
 * major number. `undefined` when the version has no major number to use.
 */
export function userAgentFor(version: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const major = /^(\d+)\./.exec(version)?.[1];
  if (major === undefined) return undefined;
  return `Mozilla/5.0 (${platformToken(platform)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** `Accept-Language` for `locale`: `en-US` → `en-US,en;q=0.9`. */
export function acceptLanguageFor(locale: string): string {
  const language = locale.split("-")[0] ?? locale;
  return language === locale ? locale : `${locale},${language};q=0.9`;
}

/** A context's options: the desktop viewport, the user agent when known, and the operator's locale and zone. */
export function contextOptionsFor(identity: BrowserIdentity, userAgent: string | undefined): BrowserContextOptions {
  return {
    viewport: { ...BROWSER_VIEWPORT },
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(identity.locale === undefined
      ? {}
      : { locale: identity.locale, extraHTTPHeaders: { "Accept-Language": acceptLanguageFor(identity.locale) } }),
    ...(identity.timezoneId === undefined ? {} : { timezoneId: identity.timezoneId }),
  };
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function parseEd25519PrivateKey(raw: string): KeyObject {
  const trimmed = raw.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return createPrivateKey(trimmed);
  }
  const seed = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (seed.length !== 32) {
    throw new TaviError("INVALID_INPUT", "Ed25519 private key must be a PEM key or a 32-byte seed (hex or base64)");
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function authorityOf(url: URL): string {
  const host = url.hostname.toLowerCase();
  const defaultPort = url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
  return url.port !== "" && url.port !== defaultPort ? `${host}:${url.port}` : host;
}

function structuredFieldString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  const inner = trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed;
  if (inner === "" || /["\\\u0000-\u001f\u007f]/.test(inner)) {
    throw new TaviError("INVALID_INPUT", `Invalid ${fieldName} value for HTTP Message Signature`);
  }
  return `"${inner}"`;
}

/**
 * Signs an outgoing HTTP request using RFC 9421 HTTP Message Signatures and the
 * IETF `webbotauth` profile (`alg="ed25519"`, `tag="web-bot-auth"`).
 */
export function signAgentRequest(
  target: string | URL,
  config: AgentSignatureConfig,
  options?: { readonly nowEpochSeconds?: number; readonly nonce?: string },
): {
  readonly "Signature-Input": string;
  readonly Signature: string;
  readonly "Signature-Agent"?: string;
} {
  const url = typeof target === "string" ? new URL(target) : target;
  if (config.keyId.trim() === "" || /["\\\u0000-\u001f\u007f]/.test(config.keyId)) {
    throw new TaviError("INVALID_INPUT", "Invalid keyId for HTTP Message Signature");
  }
  const key = parseEd25519PrivateKey(config.privateKey);
  const created = Math.floor(options?.nowEpochSeconds ?? Date.now() / 1_000);
  const ttl = Math.max(1, Math.min(config.ttlSeconds ?? 300, 3_600));
  const expires = created + ttl;
  const nonce = options?.nonce ?? randomBytes(16).toString("base64url");
  if (/["\\\u0000-\u001f\u007f]/.test(nonce)) {
    throw new TaviError("INVALID_INPUT", "Invalid nonce for HTTP Message Signature");
  }
  const authority = authorityOf(url);
  const agentHeader =
    config.signatureAgent === undefined || config.signatureAgent.trim() === ""
      ? undefined
      : structuredFieldString(config.signatureAgent, "Signature-Agent");
  const components = agentHeader === undefined ? ['"@authority"'] : ['"@authority"', '"signature-agent"'];
  const params = `(${components.join(" ")});created=${created};expires=${expires};keyid="${config.keyId}";alg="ed25519";nonce="${nonce}";tag="web-bot-auth"`;
  const signatureBase = [
    `"@authority": ${authority}`,
    ...(agentHeader === undefined ? [] : [`"signature-agent": ${agentHeader}`]),
    `"@signature-params": ${params}`,
  ].join("\n");
  const sig = cryptoSign(null, Buffer.from(signatureBase, "utf8"), key);
  return {
    "Signature-Input": `sig1=${params}`,
    Signature: `sig1=:${sig.toString("base64")}:`,
    ...(agentHeader === undefined ? {} : { "Signature-Agent": agentHeader }),
  };
}

/** Verifies an RFC 9421 / `webbotauth` Ed25519 signature against the request URL and headers. */
export function verifyAgentRequestSignature(
  target: string | URL,
  headers: {
    readonly "Signature-Input": string;
    readonly Signature: string;
    readonly "Signature-Agent"?: string;
  },
  privateOrPublicKey: string | KeyObject,
): boolean {
  const url = typeof target === "string" ? new URL(target) : target;
  const input = headers["Signature-Input"];
  const sigHeader = headers.Signature;
  if (!input.startsWith("sig1=") || !sigHeader.startsWith("sig1=:") || !sigHeader.endsWith(":")) return false;
  const params = input.slice("sig1=".length);
  const sigBytes = Buffer.from(sigHeader.slice("sig1=:".length, -1), "base64");
  const authority = authorityOf(url);
  const agentHeader = headers["Signature-Agent"];
  const signatureBase = [
    `"@authority": ${authority}`,
    ...(agentHeader === undefined ? [] : [`"signature-agent": ${agentHeader}`]),
    `"@signature-params": ${params}`,
  ].join("\n");
  const pubKey =
    typeof privateOrPublicKey === "string"
      ? createPublicKey(parseEd25519PrivateKey(privateOrPublicKey))
      : privateOrPublicKey.type === "public"
        ? privateOrPublicKey
        : createPublicKey(privateOrPublicKey);
  return cryptoVerify(null, Buffer.from(signatureBase, "utf8"), pubKey, sigBytes);
}

/**
 * Reads opt-in signed agent identity configuration from operator environment
 * variables: the key id, and the private key from the file
 * `TAVI_AGENT_SIGNATURE_KEY_FILE` names (else, in the variable itself).
 */
export function agentSignatureFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  readKey: (path: string) => string = (path) => readFileSync(path, "utf8"),
): AgentSignatureConfig | undefined {
  const keyId = env["TAVI_AGENT_SIGNATURE_KEY_ID"]?.trim();
  const keyFile = env["TAVI_AGENT_SIGNATURE_KEY_FILE"]?.trim();
  const fromFile = keyFile !== undefined && keyFile !== "";
  let privateKey: string | undefined;
  try {
    privateKey = fromFile ? readKey(keyFile).trim() : env["TAVI_AGENT_SIGNATURE_PRIVATE_KEY"]?.trim();
  } catch (error) {
    throw new TaviError("INVALID_INPUT", `TAVI_AGENT_SIGNATURE_KEY_FILE names ${keyFile}, which could not be read`, {
      details: { cause: errorMessage(error) },
    });
  }
  if (keyId === undefined || keyId === "" || privateKey === undefined || privateKey === "") return undefined;
  // Checked once, here: a key that does not parse is said at startup, naming where it came from, not on every request.
  try {
    parseEd25519PrivateKey(privateKey);
  } catch {
    throw new TaviError(
      "INVALID_INPUT",
      `${fromFile ? "TAVI_AGENT_SIGNATURE_KEY_FILE" : "TAVI_AGENT_SIGNATURE_PRIVATE_KEY"} holds no Ed25519 private key (PEM, or a 32-byte seed in hex or base64)`,
    );
  }
  const signatureAgent = env["TAVI_AGENT_SIGNATURE_AGENT"]?.trim();
  return {
    keyId,
    privateKey,
    ...(signatureAgent === undefined || signatureAgent === "" ? {} : { signatureAgent }),
  };
}

/** The host's own locale and timezone, as Node resolves them; a part it cannot name is left out. */
export function hostIdentity(env: NodeJS.ProcessEnv = process.env): BrowserIdentity {
  const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();
  const signature = agentSignatureFromEnv(env);
  return {
    ...(locale === "" ? {} : { locale }),
    ...(timeZone === undefined || timeZone === "" ? {} : { timezoneId: timeZone }),
    ...(signature === undefined ? {} : { signature }),
  };
}
