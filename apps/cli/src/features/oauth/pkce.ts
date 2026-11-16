import { createHash, randomBytes } from "node:crypto";

/** `bytes` random bytes, base64url: a sign-in's `state`, nonce or PKCE verifier. */
export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** RFC 7636 S256: the challenge a PKCE `verifier` is sent as. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** A fresh PKCE verifier of `bytes` random bytes, and its S256 challenge. */
export function pkcePair(bytes: number): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomToken(bytes);
  return { verifier, challenge: pkceChallenge(verifier) };
}
