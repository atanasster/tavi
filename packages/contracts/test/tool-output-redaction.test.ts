import { describe, expect, it } from "vitest";

import {
  containsRedactionPlaceholder,
  maskPluginText,
  maskedSecretsNote,
  redactToolOutput,
  redactToolText,
  scrubCredentialText,
} from "../src/redaction.js";

/** Shapes only, over string leaves, so JSON keeps its shape. */
describe("redactToolOutput", () => {
  const positives: readonly (readonly [string, string])[] = [
    ["aws-key", "AKIAIOSFODNN7EXAMPLE"],
    ["aws-key", "ASIAY34FZKBOKMUTVV7A"],
    ["github-token", `ghp_${"a1B2".repeat(9)}`],
    ["github-token", `gho_${"Zz09".repeat(9)}`],
    ["github-token", `github_pat_${"x".repeat(22)}_${"y".repeat(59)}`],
    ["gitlab-token", "glpat-abcdefghij0123456789"],
    ["slack-token", "xoxb-1234567890-abcdefghij"],
    ["slack-token", "xapp-1-A0123456789-abcdef"],
    ["stripe-key", "sk_live_51H8abcdefghijklmnop"],
    ["stripe-key", "rk_test_51H8abcdefghijklmnop"],
    ["api-key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"],
    ["api-key", "sk-proj-abcdefghijklmnopqrstuvwxyz"],
    ["google-key", `AIza${"S".repeat(35)}`],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["bearer-token", "Authorization: Bearer abcdefghijklmnop0123"],
  ];

  it.each(positives)("masks a %s", (kind, secret) => {
    const { value, masked } = redactToolOutput({ text: `before ${secret} after` });
    expect(JSON.stringify(value)).not.toContain(secret.split(" ").at(-1));
    expect(JSON.stringify(value)).toContain(`[redacted:${kind}]`);
    expect(masked[kind as keyof typeof masked]).toBe(1);
  });

  it("masks a PEM private key and keeps a certificate", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
    const cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    const { value, masked } = redactToolOutput(`${cert}\n${pem}`);
    expect(value).toBe(`${cert}\n[redacted:private-key]`);
    expect(masked).toEqual({ "private-key": 1 });
  });

  const negatives: readonly string[] = [
    "commit 9fceb02d0ae598e95dc970b74767f19372d61af8",
    "id 123e4567-e89b-12d3-a456-426614174000",
    "blob aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ=",
    "the ghostwriter wrote it",
    "tokens: 512",
    "max_tokens=4096",
    "secretary: Jane",
    "password_reset=true",
    "my-sk-module-name",
    "Bearer of bad news",
    "AKIA is a prefix",
  ];

  it.each(negatives)("leaves %s unchanged", (text) => {
    expect(redactToolOutput({ text }).value).toEqual({ text });
    expect(redactToolOutput({ text }).masked).toEqual({});
  });

  it("keeps JSON valid: keys, numbers and nesting survive", () => {
    const output = { password: "x", nested: [{ key: "AKIAIOSFODNN7EXAMPLE", n: 3 }], ok: true };
    const { value } = redactToolOutput(output);
    expect(value).toEqual({ password: "x", nested: [{ key: "[redacted:aws-key]", n: 3 }], ok: true });
    expect(() => JSON.parse(JSON.stringify(value))).not.toThrow();
  });

  it("returns the same object when nothing matched", () => {
    const output = { a: "plain" };
    expect(redactToolOutput(output).value).toBe(output);
  });

  it("keeps a key named __proto__ as an own property", () => {
    const output = JSON.parse('{"__proto__":{"k":"AKIAIOSFODNN7EXAMPLE"}}') as unknown;
    const { value } = redactToolOutput(output);
    expect(Object.getOwnPropertyNames(value)).toContain("__proto__");
  });

  it("replaces a subtree past the depth bound rather than passing it unscanned", () => {
    let deep: unknown = "AKIAIOSFODNN7EXAMPLE";
    for (let index = 0; index < 80; index += 1) deep = [deep];
    expect(JSON.stringify(redactToolOutput(deep).value)).toContain("[redacted:too-deep]");
  });

  it("finds a placeholder anywhere in an input", () => {
    expect(containsRedactionPlaceholder({ content: "key=[redacted:aws-key]" })).toBe(true);
    expect(containsRedactionPlaceholder({ args: ["a", { b: "[redacted:jwt]" }] })).toBe(true);
    expect(containsRedactionPlaceholder({ content: "[redacted]" })).toBe(false);
  });

  it("says what it masked, never the values", () => {
    expect(maskedSecretsNote({ "aws-key": 1, "github-token": 1 })).toBe("2 secrets masked (aws-key, github-token) — tools.redactResults");
    expect(maskedSecretsNote({})).toBeUndefined();
    expect(redactToolText("Bearer abcdefghijklmnop0123").text).toBe("Bearer [redacted:bearer-token]");
  });

  it("masks plugin text by shape and by key name, then keeps it within its bound", () => {
    expect(maskPluginText("password=hunter2 and AKIAIOSFODNN7EXAMPLE")).toBe("password: [redacted] and [redacted:aws-key]");
    expect(maskPluginText(`xoxb-${"a".repeat(110)}`, 120).length).toBeLessThanOrEqual(120);
  });
});

/**
 * One shape list behind both scrubbers: each kind's positive is masked by `redactToolText` and by
 * `scrubCredentialText`, and its near-miss (prose, a prefix alone, a short or differently shaped
 * value) by neither. The web-search secret check runs the same near-misses and must not ask.
 */
const SHAPE_FIXTURES: readonly { readonly kind: string; readonly secret: string; readonly text: string; readonly nearMiss: string }[] = [
  {
    kind: "aws-key",
    secret: "AKIAIOSFODNN7EXAMPLE",
    text: "key AKIAIOSFODNN7EXAMPLE leaked",
    nearMiss: "AKIA is the prefix of AKIAIOSFODNN7",
  },
  {
    kind: "github-token",
    secret: `github_pat_${"x".repeat(22)}_${"y".repeat(59)}`,
    text: `use github_pat_${"x".repeat(22)}_${"y".repeat(59)} here`,
    nearMiss: "github_pat_ prefix docs",
  },
  {
    kind: "stripe-key",
    secret: "sk_live_51H8abcdefghijklmnop",
    text: "stripe sk_live_51H8abcdefghijklmnop key",
    nearMiss: "sk_live_ keys explained",
  },
  {
    kind: "jwt",
    secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    text: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U done",
    nearMiss: "decode eyJhbGciOi header",
  },
  { kind: "slack-token", secret: "xapp-1-A0123456789-abcdef", text: "app xapp-1-A0123456789-abcdef", nearMiss: "xapp-1 socket mode" },
  {
    kind: "huggingface-token",
    secret: `hf_${"aB3d".repeat(8)}xy`,
    text: `HF hf_${"aB3d".repeat(8)}xy token`,
    nearMiss: "hf_hub_download docs",
  },
  {
    kind: "npm-token",
    secret: `npm_${"Ab12".repeat(9)}`,
    text: `npm npm_${"Ab12".repeat(9)} publish`,
    nearMiss: `npm_${"Ab12".repeat(9)}x`,
  },
  {
    kind: "pypi-token",
    secret: `pypi-AgEIcHlwaS5vcmc${"Q".repeat(50)}`,
    text: `upload pypi-AgEIcHlwaS5vcmc${"Q".repeat(50)} now`,
    nearMiss: "pypi-simple index mirror",
  },
  {
    kind: "sendgrid-key",
    secret: `SG.${"a".repeat(22)}.${"b".repeat(43)}`,
    text: `mail SG.${"a".repeat(22)}.${"b".repeat(43)} key`,
    nearMiss: "SG.Engineering.Team roster",
  },
  {
    kind: "telegram-token",
    secret: `123456789:AA${"h".repeat(33)}`,
    text: `bot 123456789:AA${"h".repeat(33)} start`,
    nearMiss: "123456789:AAbc and flight 10:30 AA",
  },
  {
    kind: "connection-string",
    secret: "pass",
    text: "db postgres://user:pass@h/app",
    nearMiss: "https://registry.npmjs.org:443/@tavi/contracts",
  },
  { kind: "connection-string", secret: "secret", text: "cache redis://:secret@h:6379", nearMiss: "https://example.com:8080/a@b?c=d" },
];

describe("one credential-shape list for both scrubbers", () => {
  it.each(SHAPE_FIXTURES)("masks a $kind in both and leaves its near-miss in neither", ({ kind, secret, text, nearMiss }) => {
    const tool = redactToolText(text);
    expect(tool.masked).toEqual([kind]);
    expect(tool.text).not.toContain(secret);
    expect(scrubCredentialText(text)).not.toContain(secret);
    expect(scrubCredentialText(text)).toContain("[redacted]");
    expect(redactToolText(nearMiss)).toEqual({ text: nearMiss, masked: [] });
    expect(scrubCredentialText(nearMiss)).toBe(nearMiss);
  });

  it("keeps the scheme, the user and the host of a connection string", () => {
    expect(redactToolText("postgres://user:pass@h").text).toBe("postgres://user:[redacted:connection-string]@h");
    expect(scrubCredentialText("redis://:secret@h")).toBe("redis://:[redacted]@h");
  });

  it("leaves a connection string's placeholder password, a template rather than a secret", () => {
    for (const template of [
      "mongodb+srv://<username>:<password>@cluster0.mongodb.net/test",
      "postgres://user:${DB_PASS}@db/app",
      "postgres://user:$DB_PASS@db/app",
      "postgresql://USER:PASSWORD@HOST:PORT/DB",
      "redis://default:****@redis",
      "amqp://guest:xxx@rabbit",
    ]) {
      expect(redactToolText(template), template).toEqual({ text: template, masked: [] });
      expect(scrubCredentialText(template), template).toBe(template);
    }
    expect(redactToolText("postgres://user:passwords1@h").masked).toEqual(["connection-string"]);
    // A password that only starts with `$`, or holds a placeholder before a further `@`, is a secret.
    expect(redactToolText("postgres://admin:$ecretP4ss@db").text).toBe("postgres://admin:[redacted:connection-string]@db");
    expect(redactToolText("postgres://admin:$lowercase@db").masked).toEqual(["connection-string"]);
    expect(redactToolText("postgres://u:****@real@db").text).toBe("postgres://u:[redacted:connection-string]@db");
  });

  it("masks a password holding `@` up to the authority's last `@`, and nothing past the authority", () => {
    expect(redactToolText("postgres://admin:p@ssw0rd@db").text).toBe("postgres://admin:[redacted:connection-string]@db");
    expect(scrubCredentialText("postgres://admin:p@ss@w0rd@db:5432/app?ssl=1")).toBe("postgres://admin:[redacted]@db:5432/app?ssl=1");
    expect(redactToolText("redis://:pass@@cache").text).toBe("redis://:[redacted:connection-string]@cache");
    // An `@` in the path, query or fragment is not the authority's.
    expect(redactToolText("postgres://u:pass@db/app@v2?by=a@b#c@d").text).toBe(
      "postgres://u:[redacted:connection-string]@db/app@v2?by=a@b#c@d",
    );
    // A quoted neighbour with an `@` of its own (JSON, an HTML attribute) is not swallowed.
    expect(redactToolText('{"url":"postgres://u:pass@db","mail":"a@b.c"}').text).toBe(
      '{"url":"postgres://u:[redacted:connection-string]@db","mail":"a@b.c"}',
    );
    expect(redactToolText('<a href="http://u:pw@h">x@y</a>').text).toBe('<a href="http://u:[redacted:connection-string]@h">x@y</a>');
    // `/`, `?` and `#` end the authority (RFC 3986), so a password holding one is percent-encoded, and masked so.
    expect(redactToolText("postgres://admin:ab%2Fcd99@db").masked).toEqual(["connection-string"]);
    expect(redactToolText("amqp://guest:hunter2%23x@mq").masked).toEqual(["connection-string"]);
  });

  it("scans hostile `@` runs after a connection string's user in linear time", () => {
    for (const hostile of [
      `x://u:${"@".repeat(400_000)}`,
      `x://u:${"a@".repeat(200_000)}`,
      `x://u:a${'@a"'.repeat(150_000)}`,
      `x://u:${"a".repeat(400_000)}"`,
      "a://u:p@".repeat(100_000),
      'a://u:p@h"@'.repeat(80_000),
    ]) {
      const started = Date.now();
      redactToolText(hostile);
      scrubCredentialText(hostile);
      expect(Date.now() - started, hostile.slice(0, 12)).toBeLessThan(2_000);
    }
  });

  it("scans a long dotted run without rescanning it from every boundary", () => {
    const hostile = "a.".repeat(200_000);
    const started = Date.now();
    expect(redactToolText(hostile).masked).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
