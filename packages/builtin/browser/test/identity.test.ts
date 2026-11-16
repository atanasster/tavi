import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  BROWSER_VIEWPORT,
  acceptLanguageFor,
  agentSignatureFromEnv,
  contextOptionsFor,
  hostIdentity,
  launchOptionsFor,
  signAgentRequest,
  userAgentFor,
  verifyAgentRequestSignature,
  withoutAgentSignatureKey,
} from "../src/identity.js";

describe("browser identity", () => {
  it("launches the full Chromium headless, or an off-screen window, without automation switches", () => {
    expect(launchOptionsFor("headless", "linux")).toEqual({
      headless: true,
      channel: "chromium",
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
      chromiumSandbox: true,
      env: expect.any(Object),
    });
    expect(Object.keys(launchOptionsFor("headless").env ?? {})).not.toContain("TAVI_AGENT_SIGNATURE_PRIVATE_KEY");
    // Chromium's own sandbox, which Playwright leaves off (SANDBOX F7), on both platforms.
    expect(launchOptionsFor("headless", "darwin")).toMatchObject({ chromiumSandbox: true });
    expect(launchOptionsFor("headed", "linux")).toMatchObject({ chromiumSandbox: true });
    expect(launchOptionsFor("headless", "win32")).not.toHaveProperty("chromiumSandbox");
    const headed = launchOptionsFor("headed");
    expect(headed.headless).toBe(false);
    expect(headed.channel).toBeUndefined();
    expect(headed.args).toContain("--window-position=-32000,-32000");
    expect(headed.args?.some((arg) => arg.includes("disable-gpu"))).toBe(false);
  });

  it("says Chrome with the major version, on the host's platform", () => {
    expect(userAgentFor("153.0.8010.12", "darwin")).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    );
    expect(userAgentFor("153.0.8010.12", "win32")).toContain("(Windows NT 10.0; Win64; x64)");
    expect(userAgentFor("153.0.8010.12", "linux")).toContain("(X11; Linux x86_64)");
    expect(userAgentFor("153.0.8010.12", "linux")).not.toContain("Headless");
    expect(userAgentFor("nightly")).toBeUndefined();
  });

  it("reports the operator's locale and zone", () => {
    expect(acceptLanguageFor("en-US")).toBe("en-US,en;q=0.9");
    expect(acceptLanguageFor("bg")).toBe("bg");
    expect(contextOptionsFor({ locale: "bg-BG", timezoneId: "Europe/Sofia" }, "UA")).toEqual({
      viewport: BROWSER_VIEWPORT,
      userAgent: "UA",
      locale: "bg-BG",
      extraHTTPHeaders: { "Accept-Language": "bg-BG,bg;q=0.9" },
      timezoneId: "Europe/Sofia",
    });
    expect(contextOptionsFor({}, undefined)).toEqual({ viewport: BROWSER_VIEWPORT });
  });

  it("signs outgoing requests with Ed25519 HTTP Message Signatures (RFC 9421 / webbotauth) when opted in", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const signed = signAgentRequest(
      "https://example.com:8443/flights?q=1",
      {
        keyId: "thumbprint-123",
        privateKey: pem,
        signatureAgent: "https://agent.example.com",
        ttlSeconds: 180,
      },
      { nowEpochSeconds: 1_730_000_000, nonce: "nonce-abc" },
    );
    expect(signed["Signature-Agent"]).toBe('"https://agent.example.com"');
    expect(signed["Signature-Input"]).toBe(
      'sig1=("@authority" "signature-agent");created=1730000000;expires=1730000180;keyid="thumbprint-123";alg="ed25519";nonce="nonce-abc";tag="web-bot-auth"',
    );
    expect(signed.Signature).toMatch(/^sig1=:[A-Za-z0-9+/=]+:$/);
    expect(verifyAgentRequestSignature("https://example.com:8443/flights?q=1", signed, publicKey)).toBe(true);
    expect(verifyAgentRequestSignature("https://other.example.com:8443/flights?q=1", signed, publicKey)).toBe(false);

    // Also supports a 32-byte raw seed in hex and omits Signature-Agent when not configured.
    const hexSeed = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    const seedSigned = signAgentRequest(
      "https://example.com:443/path",
      { keyId: "seed-key", privateKey: hexSeed },
      { nowEpochSeconds: 1_730_000_000, nonce: "n1" },
    );
    expect(seedSigned["Signature-Agent"]).toBeUndefined();
    expect(seedSigned["Signature-Input"]).toContain('sig1=("@authority");');
    expect(verifyAgentRequestSignature("https://example.com/path", seedSigned, hexSeed)).toBe(true);

    // Opt-in via environment variables.
    expect(agentSignatureFromEnv({})).toBeUndefined();
    // The key from the file the variable names, never what a page or process reads of the environment.
    expect(
      agentSignatureFromEnv({ TAVI_AGENT_SIGNATURE_KEY_ID: "file-key", TAVI_AGENT_SIGNATURE_KEY_FILE: "/keys/agent" }, (path) =>
        path === "/keys/agent" ? `${hexSeed}\n` : "",
      ),
    ).toEqual({ keyId: "file-key", privateKey: hexSeed });
    expect(
      withoutAgentSignatureKey({ PATH: "/bin", TAVI_AGENT_SIGNATURE_PRIVATE_KEY: "k", TAVI_AGENT_SIGNATURE_KEY_FILE: "/keys/agent" }),
    ).toEqual({ PATH: "/bin" });
    // A key file that is missing, or holds no key, is said at once, naming the variable.
    expect(() =>
      agentSignatureFromEnv({ TAVI_AGENT_SIGNATURE_KEY_ID: "k", TAVI_AGENT_SIGNATURE_KEY_FILE: "/nowhere" }, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/TAVI_AGENT_SIGNATURE_KEY_FILE names \/nowhere/);
    expect(() => agentSignatureFromEnv({ TAVI_AGENT_SIGNATURE_KEY_ID: "k", TAVI_AGENT_SIGNATURE_PRIVATE_KEY: "not-a-key" })).toThrow(
      /TAVI_AGENT_SIGNATURE_PRIVATE_KEY holds no Ed25519 private key/,
    );
    const fromEnv = hostIdentity({
      TAVI_AGENT_SIGNATURE_KEY_ID: "env-key",
      TAVI_AGENT_SIGNATURE_PRIVATE_KEY: hexSeed,
      TAVI_AGENT_SIGNATURE_AGENT: "https://agent.example.com",
    });
    expect(fromEnv.signature).toEqual({
      keyId: "env-key",
      privateKey: hexSeed,
      signatureAgent: "https://agent.example.com",
    });

    // Rejects header/structured-field injection characters in keyId or signatureAgent.
    expect(() =>
      signAgentRequest("https://example.com/", {
        keyId: 'bad"key',
        privateKey: hexSeed,
      }),
    ).toThrow(/Invalid keyId/);
  });
});

describe("an upload's media type", () => {
  it("reads it from the file's extension, as a page's picker does, else bytes", async () => {
    const { mediaTypeOf } = await import("../src/playwright.js");
    expect(mediaTypeOf("photo.JPG")).toBe("image/jpeg");
    expect(mediaTypeOf("report.pdf")).toBe("application/pdf");
    expect(mediaTypeOf("notes")).toBe("application/octet-stream");
    expect(mediaTypeOf("archive.unknownext")).toBe("application/octet-stream");
  });
});
