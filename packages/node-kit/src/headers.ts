export interface SecurityHeaderOptions {
  /** Also keep the page's window and resources to its own origin (`Cross-Origin-Opener-Policy` and `-Resource-Policy`). */
  readonly sameOrigin?: boolean;
}

/**
 * The headers every page Tavi serves itself carries: `csp`, no MIME sniffing,
 * no referrer, no framing, no caching; and with `sameOrigin`, the
 * cross-origin opener and resource policies.
 */
export function securityHeaders(csp: string, options: SecurityHeaderOptions = {}): Record<string, string> {
  return {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cache-control": "no-store",
    ...(options.sameOrigin === true ? { "cross-origin-opener-policy": "same-origin", "cross-origin-resource-policy": "same-origin" } : {}),
  };
}
