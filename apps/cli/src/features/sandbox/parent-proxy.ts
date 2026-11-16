/**
 * `serve --sandbox-parent-proxy`'s URL check, in a module of its own: the CLI's
 * flag parsing reads it on start-up, which must not load the sandbox engine.
 */

/** Why a parent proxy's URL is refused, or `undefined`: it must be an http(s) URL naming a host. */
export function parentProxyProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `takes a proxy URL such as http://proxy.example:3128 (received ${JSON.stringify(redactedUrl(raw))})`;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "")
    return `takes an http:// or https:// proxy URL (received ${JSON.stringify(redactedUrl(raw))})`;
  return undefined;
}

/** A URL as it may be printed: a user and password in it masked. */
export function redactedUrl(raw: string): string {
  return raw.replace(/\/\/[^/@\s]*@/, "//***@");
}
