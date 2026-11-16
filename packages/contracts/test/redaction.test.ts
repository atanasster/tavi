import { describe, expect, it } from "vitest";

import { ProjectRecordSchema } from "../src/projects.js";
import {
  redactCredentialPrefixes,
  redactCredentialShapes,
  redactSecretsInText,
  redactToolText,
  scrubCredentialText,
  SECRET_FIELD_DENYLIST,
} from "../src/redaction.js";

/**
 * Secret exclusion in free text: a fixed field-name denylist for
 * `key: value` pairs, plus credential shapes anywhere in the text.
 */

describe("SECRET_FIELD_DENYLIST", () => {
  it("SECRET_FIELD_DENYLIST is the exact fixed list, plus `authorization`", () => {
    // `authorization` is on it because a provider error
    // body carrying `"Authorization": "Bearer sk-live-…"` would have the value echoed
    // verbatim if the key name were not on the list.
    expect(SECRET_FIELD_DENYLIST).toEqual(["apikey", "token", "password", "secret", "credential", "authorization"]);
  });
});

describe("redactSecretsInText", () => {
  it("redacts a key: value pair naming a denylisted field", () => {
    expect(redactSecretsInText("call failed with apiKey: sk-live-123 in the request")).toBe(
      "call failed with apiKey: [redacted] in the request",
    );
  });

  it("redacts a key=value pair", () => {
    expect(redactSecretsInText("token=abc123 rejected")).toBe("token: [redacted] rejected");
  });

  it("redacts a JSON-quoted pair", () => {
    expect(redactSecretsInText('body was {"password": "hunter2", "ok": true}')).toContain('"password: [redacted]');
  });

  it("redacts a backslash-escaped JSON-quoted pair (a model relaying a tool's raw JSON error verbatim, e.g. inside a markdown code fence)", () => {
    const text = 'error: {\\"error\\":\\"upstream rejected\\",\\"apiKey\\":\\"sk-live-embedded-json-secret\\"}';
    const result = redactSecretsInText(text);
    expect(result).not.toContain("sk-live-embedded-json-secret");
    expect(result).toContain("apiKey: [redacted]");
  });

  it("leaves ordinary text with no denylisted field untouched", () => {
    const text = "the tool call to reporting.export failed: file not found";
    expect(redactSecretsInText(text)).toBe(text);
  });

  it("stops the replaced value at the next delimiter, never eating unrelated trailing text", () => {
    expect(redactSecretsInText("apiKey: sk-live-123, region: us-east-1")).toBe("apiKey: [redacted], region: us-east-1");
  });

  it("completes quickly on a large adversarial input with no delimiters (regression: the unbounded-quantifier regex was quadratic)", () => {
    const pathological = "token".repeat(20_000); // ~100k chars, all word characters, no [:=] anywhere
    const start = Date.now();
    redactSecretsInText(pathological);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("redactCredentialPrefixes", () => {
  it("masks short prefix fragments and leaves every full-length shape for the tool-output redaction to label", () => {
    const github = `ghp_${"a".repeat(36)}`;
    const text = `sk-abc123 ghp_xxxxxx AIza${"b".repeat(22)} Bearer abc12345 AKIAIOSFODNN7EXAMPLE ${github} Authorization: Bearer ${"c".repeat(20)}`;
    const masked = redactCredentialPrefixes(text);
    expect(masked).toBe(
      `[redacted] [redacted] [redacted] Bearer [redacted] AKIAIOSFODNN7EXAMPLE ${github} Authorization: Bearer ${"c".repeat(20)}`,
    );
    expect(redactToolText(masked).masked).toEqual(["aws-key", "github-token", "bearer-token"]);
    // The same prefixes `redactCredentialShapes` masks, which masks the full shapes too.
    expect(redactCredentialShapes(text)).not.toMatch(/sk-abc|ghp_|AIza|AKIA|abc12345|cccc/);
    expect(redactCredentialPrefixes("plain prose")).toBe("plain prose");
  });
});

describe("redactCredentialShapes", () => {
  it("removes a credential that has no denylisted key name in front of it", () => {
    // `redactSecretsInText` needs a key name, so an echoed
    // request body carrying `"Authorization": "Bearer sk-live-…"` kept the value.
    const echoed = '400 Bad Request: {"error":"invalid","request":{"headers":{"Authorization":"Bearer sk-live-9f8a7b6c5d4e3f2a1b"}}}';
    expect(redactSecretsInText(echoed)).toContain("sk-live-9f8a7b6c5d4e3f2a1b");
    const scrubbed = redactCredentialShapes(redactSecretsInText(echoed));
    expect(scrubbed).not.toContain("sk-live-9f8a7b6c5d4e3f2a1b");
    expect(scrubbed).toContain("[redacted]");
  });

  it("catches the shapes a provider or proxy actually leaks", () => {
    expect(redactCredentialShapes("Authorization: Bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(redactCredentialShapes("key sk-proj-abcdef123456 here")).not.toContain("sk-proj-abcdef123456");
    expect(redactCredentialShapes("token ghp_abcdef123456")).not.toContain("ghp_abcdef123456");
    expect(redactCredentialShapes("xoxb-1234567890-abcdef")).not.toContain("abcdef");
    expect(redactCredentialShapes("AIzaSyA1234567890abcdefghijklmnopqrst")).not.toContain("AIzaSyA");
    expect(redactCredentialShapes("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----")).toBe("[redacted private key]");
    // Ordinary prose is untouched: a false positive costs a readable diagnostic,
    // but mangling every response would make the tool useless.
    expect(redactCredentialShapes("the bearer of good news arrived")).toBe("the bearer of good news arrived");
  });

  it("redacts a PEM private key in linear time, and an unterminated marker costs nothing", () => {
    // The lazy `[\s\S]*?` version rescanned the whole remaining string for every
    // BEGIN with no matching END: a 4 MiB body with 135 000 unterminated markers
    // took over 60 seconds on this very function, and both callers take
    // attacker-influenced input (a remote response body, a provider error message).
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(redactCredentialShapes(`body: ${pem} done`)).toBe("body: [redacted private key] done");
    // A certificate marker is not a private key and is left alone.
    const cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    expect(redactCredentialShapes(cert)).toBe(cert);

    const hostile = "-----BEGIN RSA PRIVATE KEY-----\n".repeat(40_000);
    const started = Date.now();
    const result = redactCredentialShapes(hostile);
    // Generous, but two orders of magnitude below the quadratic version's >60 s.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toBe(hostile);
  });

  it("composes both passes, so a key-named credential is caught wherever shapes are", () => {
    // With only the shape half, `apiKey: <hex>` would still reach the
    // durable task row, the terminal and the model's context.
    const message = "upstream said: apiKey: 9f8a7b6c5d4e3f2a1b2c3d4e5f6a7b8c is invalid";
    expect(scrubCredentialText(message)).not.toContain("9f8a7b6c5d4e3f2a1b2c3d4e5f6a7b8c");
    expect(scrubCredentialText('headers: {"Authorization": "Bearer sk-live-abcdef123456"}')).not.toContain("sk-live-abcdef123456");
  });

  it("drops a provider's link to one key's settings page", () => {
    expect(scrubCredentialText("visit https://openrouter.ai/workspaces/default/keys/abcdef0123456789abcdef0123456789 to adjust")).toBe(
      "visit [the key's settings page] to adjust",
    );
    expect(scrubCredentialText("see https://example.com/docs/keys")).toBe("see https://example.com/docs/keys");
  });

  it("catches the authorization-header shape even when the value contains a space", () => {
    // The key-name pass alone stops at the first space, so it came back as
    // `"authorization: [redacted] dXNlcjpwYXNz` — apparently redacted with the
    // credential still in the text. Every production path runs the shape pass
    // after it, which matches the header directly.
    const echoed = '"authorization": "Basic dXNlcjpwYXNz"';
    // Shape pass first, then the key-name pass — the order every production path
    // uses, and the order that matters: the key-name pass alone rewrites the value
    // into `authorization: [redacted] <rest>`, hiding the shape from the other.
    expect(redactSecretsInText(redactCredentialShapes(echoed))).not.toContain("dXNlcjpwYXNz");
  });
});

/**
 * The stored-row schema's strictness is load-bearing and rests on an
 * implementation detail of Zod's `.extend()`.
 *
 * `ProjectRecordSchema` is built by extending the `strictObject` `ProjectSchema`,
 * and the record it validates exists to catch drift between columns and the
 * current shape. If a future Zod release changed `.extend()` to relax unknown-key
 * handling, an unknown column would start passing validation silently — so the
 * assumption is pinned here rather than left to the reader.
 */
describe("ProjectRecordSchema strictness", () => {
  const valid = {
    id: "acme",
    workspaceId: "default",
    enabled: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("accepts a well-formed row and rejects an unknown key", () => {
    expect(ProjectRecordSchema.safeParse(valid).success).toBe(true);
    expect(ProjectRecordSchema.safeParse({ ...valid, unexpectedColumn: 1 }).success).toBe(false);
  });

  it("rejects a non-boolean enabled instead of coercing it to false", () => {
    // `enabled = 2` used to read as `false`, so the project silently vanished
    // from every collector while every row "read fine".
    expect(ProjectRecordSchema.safeParse({ ...valid, enabled: 2 }).success).toBe(false);
    expect(ProjectRecordSchema.safeParse({ ...valid, enabled: 0 }).success).toBe(true);
    expect(ProjectRecordSchema.safeParse({ ...valid, enabled: "1" }).success).toBe(false);
  });

  it("rejects a timestamp that is not an instant", () => {
    expect(ProjectRecordSchema.safeParse({ ...valid, createdAt: "now" }).success).toBe(false);
    expect(ProjectRecordSchema.safeParse({ ...valid, updatedAt: "" }).success).toBe(false);
  });
});
