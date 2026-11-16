import { expect, it } from "vitest";
import { scrubCredentialText } from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";

// R0 protocol prototype: capture a closed projection, never raw request objects.
function capture(value: { tool: "http.request"; url: string; error: string; errorCode: "FETCH_FAILED"; headers?: unknown }) {
  const url = new URL(value.url);
  // Paths and free-form errors can contain unrecognizable secrets too. The
  // production adapter must validate these finite fields at its boundary.
  const projection = { tool: value.tool, sourceOrigin: url.origin, errorCode: value.errorCode };
  return scrubCredentialText(JSON.stringify(projection));
}
const envelope = (sequence: number, previous: string, payloadHash: string) => JSON.stringify({ sequence, previous, payloadHash });

it("hashes only sanitized capture and verifies retained envelopes after payload pruning", () => {
  const payload = capture({
    tool: "http.request",
    url: "https://user:password@fixture.invalid/fixture-path-secret?q=fixture-secret",
    headers: { cookie: "fixture-cookie", authorization: "fixture-auth" },
    error: "fixture-unkeyed-secret rejected; apiKey: fixture-key",
    errorCode: "FETCH_FAILED",
  });
  for (const secret of [
    "password",
    "fixture-secret",
    "fixture-cookie",
    "fixture-auth",
    "fixture-key",
    "fixture-path-secret",
    "fixture-unkeyed-secret",
  ])
    expect(payload).not.toContain(secret);
  const first = { sequence: 1, previous: "", payloadHash: sha256Hex(payload) };
  const firstHash = sha256Hex(envelope(first.sequence, first.previous, first.payloadHash));
  const second = { sequence: 2, previous: firstHash, payloadHash: sha256Hex("next event") };
  expect(second.previous).toBe(sha256Hex(envelope(first.sequence, first.previous, first.payloadHash)));
  // Envelopes retain the payload digest, so verification does not need payload.
  expect(Object.keys(first)).not.toContain("payload");
  expect(second.previous).not.toBe(sha256Hex(envelope(first.sequence, first.previous, sha256Hex("tampered"))));
});
