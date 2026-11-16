import { isLoopbackHostname } from "@tavi/node-kit";

export { isLoopbackHostname };

/**
 * The operator's host allowlist language: one implementation, shared.
 *
 * These helpers used to live in the CLI's HTTP tool. A routine's grant has to
 * apply *the same* predicate to a narrower list, and a second, hand-rolled copy
 * in the runtime immediately drifted: it was exact-string only, so an operator's
 * `host:port` or `*.suffix` entry — both of which the HTTP tool accepts — was
 * refused mid-run with a denial that claimed the grant did not cover a host the
 * operator had explicitly configured. Anything that authorizes a host now calls
 * this module.
 */

export const MULTI_TENANT_SUFFIXES: readonly string[] = [
  // Base domains, not service hosts: `s3.amazonaws.com`,
  // `s3.eu-west-1.amazonaws.com` and `s3.dualstack.us-east-1.amazonaws.com` are
  // all shared, so listing the exact service host left the regional spellings
  // live — and those are the canonical ones.
  "amazonaws.com",
  "cloudfront.net",
  "windows.net",
  "azurewebsites.net",
  "azurestaticapps.net",
  "cloudapp.azure.com",
  // NOT `googleapis.com`/`googleusercontent.com`: those subdomains are Google's and
  // cannot be registered by a third party, which is the criterion — an over-broad
  // list would refuse a legitimate `*.googleapis.com` declaration.
  "appspot.com",
  "run.app",
  "workers.dev",
  "pages.dev",
  "r2.dev",
  "github.io",
  "gitlab.io",
  "herokuapp.com",
  "herokudns.com",
  "vercel.app",
  "netlify.app",
  "onrender.com",
  "fly.dev",
  "surge.sh",
  "glitch.me",
  "ngrok.io",
  "trycloudflare.com",
  "duckdns.org",
  "no-ip.org",
  "dynu.net",
  "fastly.net",
  "akamaized.net",
  "backblazeb2.com",
  "digitaloceanspaces.com",
  "linodeobjects.com",
  "objectstorage.oraclecloud.com",
  // A hand-maintained list is only as good as its entries: each of these is a hosting platform where
  // a *third party* registers the subdomain, so a wildcard over it is the same
  // egress (and credential-exfiltration) hole the list exists to close.
  "web.app",
  "firebaseapp.com",
  "sharepoint.com",
  "azureedge.net",
  "trafficmanager.net",
  "myshopify.com",
  "wordpress.com",
  "blogspot.com",
  "wixsite.com",
  "squarespace.com",
  "weebly.com",
  "notion.site",
  "readthedocs.io",
  "surgeusercontent.com",
  "zendesk.com",
  "freshdesk.com",
  "atlassian.net",
  "salesforce-sites.com",
  "force.com",
  "cloudfunctions.net",
  "edgekey.net",
  "cloudflare.net",
  "b-cdn.net",
  "stackpathdns.com",
];

/** Whether a wildcard over this suffix would grant domains the operator does not own. */
export function isMultiTenantSuffix(suffix: string): boolean {
  const normalized = suffix.toLowerCase();
  return MULTI_TENANT_SUFFIXES.some((known) => normalized === known || normalized.endsWith(`.${known}`));
}

export function normalizeHostEntry(entry: string): string | undefined {
  // A trailing dot is a fully-qualified spelling of the same name, and DNS and TLS
  // both honour it — so `*.s3.amazonaws.com.` passed the shared-suffix guard and
  // then matched `attacker.s3.amazonaws.com.` as a working grant. Stripped before anything else looks at the entry.
  const trimmed = entry.trim().replace(/\.+$/, "");
  if (trimmed === "") return undefined;
  const wildcard = trimmed.startsWith("*.");
  const bare = wildcard ? trimmed.slice(2) : trimmed;
  try {
    const parsed = new URL(`https://${bare}`);
    // A wildcard cannot carry a port, and dropping it is fail-open: `*.example.com:8443`
    // became `*.example.com` and authorized the whole suffix on the *default* port —
    // the opposite of what the operator wrote. Refused
    // instead, so the mistake is a startup error.
    if (wildcard && parsed.port !== "") return undefined;
    // A wildcard over a shared suffix is refused rather than matched: see
    // `MULTI_TENANT_SUFFIXES`.
    if (wildcard && isMultiTenantSuffix(parsed.hostname)) return undefined;
    return wildcard ? `*.${parsed.hostname}` : parsed.hostname;
  } catch {
    return undefined;
  }
}

/**
 * `host` or `host:port` for error text and comparison.
 *
 * A URL with a non-default port is a different destination from the same host on
 * 443, and the allowlist could not express one at all: `normalizeHostEntry` runs
 * the entry through `https://…` and keeps only `hostname`, so `example.com:8443`
 * was silently compared as `example.com`.
 */
export function describeHost(url: URL): string {
  return url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
}

/**
 * Whether a URL's host *and port* are permitted.
 *
 * The port matters: an allowlist entry of `example.com` must not authorize
 * `example.com:8443`, because that is a different service. A non-default port is
 * therefore allowed only when the operator's entry names that exact port — and a
 * URL with `https://`'s own default (443, or 80 for the loopback http case) is
 * accepted by the bare entry.
 */
export function hostAllowedWithPort(url: URL, allowedHosts: readonly string[]): boolean {
  // A port-qualified entry authorizes only its own port, so it must not match a
  // bare URL — otherwise `example.com:8443` would authorize `https://example.com`,
  // which is the same confusion in the other direction.
  const bareEntries = allowedHosts.filter((entry) => {
    const withPort = normalizeHostPortEntry(entry);
    return withPort === undefined || withPort === normalizeHostEntry(entry);
  });
  // Loopback is one trust domain: `http://127.0.0.1:8123` is the same machine as
  // `http://127.0.0.1:9000`, an operator cannot know a dev server's ephemeral port
  // when writing the allowlist, and the http exception below already restricts the
  // scheme to loopback. A real host is different — `example.com:8443` is a
  // different service from `example.com`.
  if (url.port === "" || isLoopbackHostname(url.hostname)) {
    if (hostAllowed(url.hostname, bareEntries)) return true;
    // A port-qualified loopback entry still authorizes its own port. Without this
    // the loopback branch discarded exactly the entry the refusal message tells
    // the operator to add (`127.0.0.1:8123`), so it could never be satisfied.
  }
  if (url.port === "") return false;
  return allowedHosts.some((entry) => normalizeHostPortEntry(entry) === `${url.hostname}:${url.port}`);
}

/**
 * A `host:port` entry, normalized, keeping the port.
 *
 * `normalizeHostEntry` deliberately keeps only the hostname (a wildcard cannot
 * carry a port), so the port-aware comparison needs its own normalization —
 * otherwise `example.com:8443` normalizes to `example.com` and could never match
 * the `example.com:8443` it is supposed to name.
 */
function normalizeHostPortEntry(entry: string): string | undefined {
  const trimmed = entry.trim();
  if (trimmed === "" || trimmed.startsWith("*.")) return undefined;
  try {
    const parsed = new URL(`https://${trimmed}`);
    return parsed.port === "" ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
  } catch {
    return undefined;
  }
}

/** Whether `host` is permitted: exact match, or a `*.suffix` entry, after normalization. */
export function hostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const candidate = normalizeHostEntry(host);
  if (candidate === undefined) return false;
  return allowedHosts.some((entry) => {
    const allowed = normalizeHostEntry(entry);
    if (allowed === undefined) return false;
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(1); // ".example.com"
      return candidate.endsWith(suffix) && candidate.length > suffix.length;
    }
    return candidate === allowed;
  });
}

/** Why the URL cannot be used, or `undefined` when it is acceptable. */
export function rejectUrl(parsed: URL, allowedHosts: readonly string[]): string | undefined {
  if (parsed.username !== "" || parsed.password !== "") {
    return "credentials embedded in the URL (userinfo) are not permitted; use credentialRef";
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) {
    return `only https is permitted (http is allowed for loopback only), got ${parsed.protocol}`;
  }
  if (!hostAllowedWithPort(parsed, allowedHosts)) {
    return (
      `${describeHost(parsed)} is not in the operator's allowlist` +
      (parsed.port === "" ? "" : " (a non-default port needs its own entry, `host:port`)")
    );
  }
  return undefined;
}

/**
 * The single host predicate, for callers that hold a URL string.
 *
 * Returns a refusal reason, or `undefined` when the URL is acceptable under
 * `allowedHosts`. This is deliberately the same predicate the operator-configured
 * HTTP tool uses (`rejectUrl`): an allowlist entry means one thing in this
 * product, and a second rule would make "intersection" a third, undocumented
 * policy.
 */
export function hostRefusal(url: string, allowedHosts: readonly string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Fetch destination is not a URL";
  }
  return rejectUrl(parsed, allowedHosts);
}
