import { z } from "zod";

import {
  type CallAssessment,
  type InvocationContext,
  type SecretReaderPort,
  TOOL_LABEL_KEY,
  TaviError,
  joinLabels,
  maxRisk,
  redactCredentialShapes,
  untrustedLabel,
} from "@tavi/contracts";
import { clip, errorMessage } from "@tavi/contracts/util";
import { readBoundedBody, sha256Hex } from "@tavi/node-kit";
import { type ToolRegistry, pinnedFetch } from "@tavi/runtime";

import { assessHttpRequest } from "../approvals/call-assessors.js";
import type { FolderSaver } from "../folders/fs-tools.js";

/**
 * The governed HTTP tool.
 *
 * Without it the runtime cannot call a single external API — `sandbox.run`
 * denies network by default and `browser.observe` exposes no response body.
 *
 * Four rules shape it, and each is enforced rather than assumed:
 *
 *  - **The host allowlist is operator policy, never model input**, and empty
 *    means deny-everything. Redirects are *not* followed, because a redirect
 *    target was never checked against that allowlist — following one would make
 *    the allowlist advisory. An allowlisted name is dialed only at the public
 *    address it resolved to (`pinnedFetch`), so the name cannot be pointed at
 *    an internal service after it was checked.
 *  - **Credentials are resolved inside the handler and never returned.** The
 *    model names a reference; the operator binds that reference to the hosts it
 *    may be sent to. A reference with no binding is refused, so the model cannot
 *    pair an operator credential with an arbitrary allowlisted host. The model
 *    may never supply auth material of its own.
 *  - **The response is bounded while it is being read**, not after: the body is
 *    streamed and abandoned at the cap, so a server that streams gigabytes
 *    cannot exhaust the daemon's memory. Header values and the whole result are
 *    capped too, because the 64 KiB gate (`workflow/tool-output.ts`'s `archiveToolOutput`)
 *    counts the entire JSON result.
 *  - **Every failure is typed.** A timeout or cancellation during the body read
 *    is as typed as one during the headers, so the workflow never sees a raw
 *    `DOMException`.
 */

/** Header the resolved credential is written to unless the operator's binding says otherwise. */
const DEFAULT_CREDENTIAL_HEADER = "authorization";
/** Prefix applied to the credential value; `Bearer <secret>` by default. */
const DEFAULT_CREDENTIAL_SCHEME = "Bearer";

/**
 * Response headers safe to hand back to the model.
 *
 * An allowlist, not a denylist: `set-cookie`, `authorization`,
 * `www-authenticate` and anything a future provider invents are excluded by
 * default rather than caught by a pattern that must be kept current.
 */
const SAFE_RESPONSE_HEADERS = ["content-type", "content-length", "date", "cache-control", "etag", "last-modified", "retry-after"];

/**
 * Request headers the model may set, by exact lower-case name.
 *
 * An *allowlist*, not the denylist this replaced: a denylist of
 * `authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|api-key`
 * let `x-goog-api-key`, `private-token` (GitLab), `x-subscription-key`,
 * `x-functions-key` and `x-amz-security-token` through — every provider invents
 * its own spelling, and the ones that are already names for auth material were
 * exactly the ones missing from the list. This file already argues for
 * allowlists over denylists on the *response* side; the request side matches.
 *
 * Everything here is a value the caller would send anyway; anything else is
 * refused with an error naming the allowlist, so a caller that needs another
 * header asks the operator to add it rather than the model inventing one.
 */
const MODEL_ALLOWED_REQUEST_HEADERS: readonly string[] = [
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "pragma",
  "range",
  "user-agent",
];

/** RFC 7230 token: the only thing `Headers.set` accepts as a name. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * The response body kept, by default: a large one is archived whole past
 * 64 KiB and the model reads the rest of it with `artifacts.read`, so an API's
 * full answer is no longer cut at a size chosen to stay under a review pause.
 */
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HEADER_VALUE_CHARS = 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Extra request headers the *operator* has allowed, on top of the built-in list.
 *
 * The refusal message tells the model to ask the operator, so the operator needs
 * a way to say yes: without this the allowlist would be closed to legitimate
 * non-credential headers (`idempotency-key`, `x-goog-user-project`) and the only
 * remaining way to send one would be to store it as a secret.
 */
export interface HttpToolOptions {
  /** Resolves a credential reference to its value, inside the handler only. */
  readonly secretReader: SecretReaderPort;
  /** Operator-authored allowlist: exact hosts, or `*.example.com` suffix forms. */
  readonly allowedHosts: readonly string[];
  /**
   * Which hosts each credential reference may be sent to, e.g.
   * `{ "acme.stripe.key": ["api.stripe.com"] }`.
   *
   * Required for any reference the model names: a reference with no entry is
   * refused rather than sent to whatever host the call happens to target. This
   * is what stops the allowlist from becoming a credential-exfiltration channel.
   */
  readonly credentialHosts?: Readonly<Record<string, readonly string[]>>;
  /**
   * Extra request headers the operator allows the model to set, on top of the
   * built-in list — `--http-request-header`, repeatable.
   *
   * The refusal message tells the model to ask the operator, so the operator needs
   * a way to say yes; without this the only way to send a legitimate
   * non-credential header (`idempotency-key`, `x-goog-user-project`) would be to store
   * it as a secret, which is not what a credential is for.
   */
  readonly extraAllowedRequestHeaders?: readonly string[];
  /**
   * Where `saveTo` writes (`folderSaver`): a new file of the calling chat's
   * folder, assessed and confined as `fs.write` holds one. Absent, `saveTo` is refused.
   */
  readonly saver?: FolderSaver;
  /** Response body cap; 1 MiB by default (`DEFAULT_MAX_RESPONSE_BYTES`). It caps a saved body too. */
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  /**
   * Test seam. Production dials through `pinnedFetch`: an allowlisted name is
   * resolved once and must answer with public addresses (loopback only for a
   * loopback host, which the allowlist admits only when the operator named it),
   * and the socket goes to the address checked, so DNS rebinding or a taken-over
   * wildcard cannot reach an internal service with the bound credential.
   */
  readonly fetchImpl?: typeof fetch;
}

const HttpRequestInputSchema = z.object({
  url: z.string().min(1).max(2048).describe("Absolute https URL to request"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method (default GET)"),
  headers: z
    .record(z.string().min(1).max(128), z.string().max(1024))
    .optional()
    .describe(
      "Extra request headers. Auth material (authorization, cookie, x-api-key, …) is refused: " +
        "use credentialRef so the operator controls the value.",
    ),
  body: z
    .string()
    .max(64 * 1024)
    .optional()
    .describe("Request body, for POST, PUT or PATCH"),
  credentialRef: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Reference to an operator-configured credential (e.g. 'acme.stripe.key'). The value is injected by " +
        "the runtime, never returned, and only sent to hosts the operator bound to that reference.",
    ),
  credentialHeader: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(`Header carrying the credential (default '${DEFAULT_CREDENTIAL_HEADER}')`),
  credentialScheme: z
    .string()
    .max(32)
    .optional()
    .describe(`Prefix before the credential value (default '${DEFAULT_CREDENTIAL_SCHEME}'; empty string for none)`),
  saveTo: z
    .string()
    .min(1)
    .max(4_096)
    .optional()
    .describe("A new file in your working folder to save the body to; the result is its path, size and sha256, not the body"),
});

import { normalizeHostEntry, describeHost, hostAllowedWithPort, hostAllowed, isLoopbackHostname, rejectUrl } from "@tavi/runtime";

// Re-exported because this module is where the CLI's other consumers (the
// sandbox/browser tool, `main.ts`, the collector) have always imported them.
export { normalizeHostEntry, hostAllowedWithPort, hostAllowed, isLoopbackHostname, rejectUrl };

/** Only headers that cannot carry secrets, with server-controlled values bounded. */
function safeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (SAFE_RESPONSE_HEADERS.includes(lower) || lower.startsWith("x-ratelimit-")) {
      out[lower] = value.length > MAX_HEADER_VALUE_CHARS ? value.slice(0, MAX_HEADER_VALUE_CHARS) : value;
    }
  }
  return out;
}

/** The effective request-header allowlist: the built-in names plus the operator's. */
function effectiveRequestHeaders(extra: readonly string[] | undefined): Set<string> {
  const allowed = new Set(MODEL_ALLOWED_REQUEST_HEADERS);
  for (const name of extra ?? []) {
    const lower = name.trim().toLowerCase();
    // An operator entry that is not an RFC 7230 token, or one that names a
    // credential header, would quietly widen the surface the built-in list exists
    // to keep closed — refused at composition instead.
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(lower)) {
      throw new TaviError("INVALID_INPUT", `--http-request-header ${JSON.stringify(name)} is not a valid header name`);
    }
    if (CREDENTIAL_HEADERS.has(lower)) {
      throw new TaviError(
        "INVALID_INPUT",
        `--http-request-header ${JSON.stringify(name)} names a credential header; bind it with --http-credential-host instead`,
      );
    }
    allowed.add(lower);
  }
  return allowed;
}

/**
 * Why the handler would refuse this call's destination, if it would: an
 * unparseable URL, one `rejectUrl` refuses, or a credential reference with no
 * binding to the host. Read by the gate's assessor; the handler repeats each
 * check itself, because the assessor runs before the call and is advisory to
 * nothing.
 */
function requestRefusal(input: unknown, options: HttpToolOptions): string | undefined {
  const call = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const raw = call["url"];
  if (typeof raw !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "the URL is not absolute";
  }
  const refusal = rejectUrl(url, options.allowedHosts);
  if (refusal !== undefined) return refusal;
  const reference = call["credentialRef"];
  if (typeof reference !== "string") return undefined;
  const hostMap = options.credentialHosts;
  const boundHosts = hostMap !== undefined && Object.hasOwn(hostMap, reference) ? hostMap[reference] : undefined;
  if (boundHosts === undefined) return `credential reference ${reference} is not bound to any host`;
  if (!hostAllowedWithPort(url, boundHosts)) return `credential reference ${reference} is not bound to ${describeHost(url)}`;
  return undefined;
}

/** Header names that carry credentials, which never come from the model. */
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
]);

/**
 * `http.request`'s description, with what it can reach: the allowed hosts, so
 * the model uses an API it may call instead of learning the list by being
 * refused, and the names of the credentials it may use. Never which host a
 * credential is bound to: that map is the operator's, and listing it would
 * tell the model where each credential can be aimed; a call that names the
 * wrong one is refused with the one binding it needs. Bounded, so a long list
 * cannot crowd the tool list.
 */
export function httpRequestDescription(options: Pick<HttpToolOptions, "allowedHosts" | "credentialHosts">): string {
  const hosts = options.allowedHosts.slice(0, DESCRIBED_ENTRIES);
  const names = Object.keys(options.credentialHosts ?? {});
  const credentials = names.slice(0, DESCRIBED_ENTRIES);
  const more = (all: number, shown: number) => (all > shown ? ` and ${all - shown} more` : "");
  return (
    "Make one bounded HTTPS request (GET, POST, PUT, PATCH or DELETE) to an operator-allowlisted host: prefer it to the browser for an API on that list; a public page is web_fetch. " +
    (hosts.length === 0 ? "" : `It can reach ${hosts.join(", ")}${more(options.allowedHosts.length, hosts.length)}. `) +
    (credentials.length === 0
      ? "No credential is bound. "
      : `Credentials it may send by credentialRef, each only to the hosts the operator bound it to: ${credentials.join(", ")}${more(names.length, credentials.length)}. The value is never returned. `) +
    "Redirects are not followed; a 3xx is the result. A response past 64 KiB is kept whole as an artifact its note names, where the owner keeps artifacts. " +
    `Example: {"url":"https://${hosts.find((host) => !host.includes("*")) ?? "api.example.com"}/v1/items","method":"POST","headers":{"content-type":"application/json"},"body":"{\\"name\\":\\"Milk\\"}"}.`
  );
}

/** The most hosts, and credential names, `http.request`'s description lists. */
const DESCRIBED_ENTRIES = 20;

/**
 * A request's assessment with its `saveTo` write: held as `fs.write` holds
 * creating that file — its refusal, its folder-qualified subject, its ask
 * under taint in a host folder, and `fs.write`'s deny and ask rules
 * (`ruleAliases`) — on top of the request's own. The sink is the stricter
 * of the two: a credential stays `credential`, a host-folder file is
 * `persist`, and a file in the managed folder leaves the request's.
 */
function withSave(request: CallAssessment, save: CallAssessment): CallAssessment {
  if (save.hardDeny !== undefined) return { ...request, hardDeny: `http.request refused: saveTo ${save.reasons[0] ?? save.hardDeny}` };
  const sink = request.sink === "credential" ? request.sink : save.sink === "persist" ? save.sink : request.sink;
  return {
    ...request,
    display: {
      ...request.display,
      detail: clip([request.display.detail, save.display.title].filter((part) => part !== undefined).join("\n"), 2_000),
    },
    subjects: [...request.subjects, ...save.subjects],
    risk: maxRisk(request.risk, save.risk),
    reasons: [...request.reasons, ...save.reasons],
    ruleAliases: ["fs.write"],
    ...(sink === undefined ? {} : { sink }),
    ...(save.askWhenTainted === true ? { askWhenTainted: true } : {}),
    ...(save.foldCase === true ? { foldCase: true } : {}),
    ...(save.onceOnly === true || request.onceOnly === true ? { onceOnly: true } : {}),
  };
}

export function registerHttpTools(registry: ToolRegistry, base: HttpToolOptions): void {
  // Built once: the allowlist, the credential bindings and the effective
  // request headers are fixed at composition — they are launch flags, and a
  // change restarts the owner, which registers the tool again — so the
  // description the model reads, the gate's assessor and the handler all
  // read one copy, and a later mutation of the operator's arrays cannot
  // widen it mid-run.
  const options: HttpToolOptions = {
    ...base,
    allowedHosts: Object.freeze([...base.allowedHosts]),
    ...(base.credentialHosts === undefined
      ? {}
      : {
          credentialHosts: Object.freeze(
            Object.fromEntries(Object.entries(base.credentialHosts).map(([reference, hosts]) => [reference, Object.freeze([...hosts])])),
          ),
        }),
  };
  const allowedRequestHeaders = effectiveRequestHeaders(options.extraAllowedRequestHeaders);
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? pinnedFetch({ allowLoopback: true });
  /** `saveTo`'s write, assessed as `fs.write` would assess creating that file; a call without one is the request alone. */
  const saveAssessed = (assessment: CallAssessment, input: unknown, context: InvocationContext): CallAssessment => {
    const saveTo = (input as { readonly saveTo?: unknown } | undefined)?.saveTo;
    if (typeof saveTo !== "string") return assessment;
    if (options.saver === undefined) return { ...assessment, hardDeny: "http.request refused: saveTo is not available here" };
    return withSave(assessment, options.saver.assess(saveTo, context, "Save the response to"));
  };

  registry.register({
    id: "http.request",
    // Never `urlOnly`: headers on a GET, a body on a POST. A call that
    // applies a stored credential is a `credential` sink, read per call.
    sink: "network",
    urlOnly: false,
    version: "1.0.0",
    description: httpRequestDescription(options),
    effect: "external",
    requiredPermissions: ["tools.invoke"],
    inputSchema: HttpRequestInputSchema,
    // The handler's own host and credential-binding checks, read at the gate:
    // a call the handler would refuse is refused before a
    // person is asked to approve it, with the same reason — an approval could
    // not have made it succeed.
    assess: (input: unknown, context: InvocationContext): CallAssessment => {
      const assessment = saveAssessed(assessHttpRequest(input), input, context);
      const refusal = requestRefusal(input, options);
      if (refusal === undefined) return assessment;
      // A site off the list is one the person can still allow: in the browser, while `tavi.browser` registers it.
      const raw = (input as { readonly url?: unknown }).url;
      const offList = typeof raw === "string" && URL.canParse(raw) && !hostAllowedWithPort(new URL(raw), options.allowedHosts);
      const pointer =
        offList && registry.has("browser.create_session")
          ? ". To read this site, open it with the browser (browser.create_session with its url): the person is asked once to allow it"
          : "";
      return { ...assessment, hardDeny: `http.request refused: ${refusal}${pointer}` };
    },
    // It asks no one where it goes: with no allowed host it could reach
    // nothing, so it is not offered, and a site the user names goes to the browser.
    offered: () => options.allowedHosts.length > 0,
    // A remote API's body is untrusted content.
    untrustedOutput: true,
    outputSource: "web",
    handler: async ({ input, context, signal, contextLabel, assessedSubjects }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "http.request was cancelled");
      const parsed = HttpRequestInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "http.request received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }

      let url: URL;
      try {
        url = new URL(parsed.data.url);
      } catch {
        throw new TaviError("INVALID_INPUT", "http.request needs an absolute URL");
      }
      const refusal = rejectUrl(url, options.allowedHosts);
      if (refusal !== undefined) {
        // `details` goes to the operator's log, never to the model. The tool's
        // description lists the allowed hosts; the *message* says what was
        // refused and what to do, and no credential's binding is named in either.
        throw new TaviError("NOT_AUTHORIZED", `http.request refused: ${refusal}`, {
          details: { host: url.hostname, allowedHostCount: options.allowedHosts.length },
        });
      }

      // The model never supplies auth material, with or without a credentialRef:
      // a supplied header would be model-chosen material sent on the operator's
      // behalf, which is the control this tool exists to provide. Only the names on
      // the allowlist above are accepted at all.
      for (const name of Object.keys(parsed.data.headers ?? {})) {
        if (!HEADER_NAME.test(name)) {
          throw new TaviError("INVALID_INPUT", `http.request received an invalid header name: ${JSON.stringify(name)}`);
        }
        const lower = name.toLowerCase();
        if (!allowedRequestHeaders.has(lower)) {
          throw new TaviError(
            "NOT_AUTHORIZED",
            `http.request may not set ${lower}: the operator controls every header that could carry auth material, ` +
              `and only these may be supplied — ${[...allowedRequestHeaders].join(", ")}. ` +
              "Use credentialRef with a header the operator has bound",
          );
        }
      }

      // A save that would be refused is refused before the request is sent: a
      // POST is not made for a file that cannot be written.
      const saveTo = parsed.data.saveTo;
      if (saveTo !== undefined) {
        const save = saveAssessed(assessHttpRequest(parsed.data), parsed.data, context).hardDeny;
        if (save !== undefined) throw new TaviError("NOT_AUTHORIZED", save);
      }

      const headers = new Headers();
      // A value with CR, LF or NUL is refused *before* `Headers.set`, whose thrown
      // message quotes the offending value — and for a credential header that value
      // is the operator's secret, which then travels to the model through
      // `error.message`. The refusal never echoes the
      // value it refused.
      const rejectHeaderValue = (name: string, value: string): void => {
        if (/[\u0000\r\n]/.test(value)) {
          throw new TaviError("INVALID_INPUT", `http.request received a header value with a control character for ${name}`);
        }
      };
      try {
        for (const [name, value] of Object.entries(parsed.data.headers ?? {})) {
          rejectHeaderValue(name, value);
          headers.set(name, value);
        }
      } catch (error) {
        if (error instanceof TaviError) throw error;
        // No `String(error)` here: the only way this branch runs is a value
        // `Headers` rejected, and its message quotes that value.
        throw new TaviError("INVALID_INPUT", "http.request could not build the request headers");
      }

      const credentialHeader = (parsed.data.credentialHeader ?? DEFAULT_CREDENTIAL_HEADER).toLowerCase();
      /** The credential sent, so a saved body that echoes it is refused. */
      let sentSecret: string | undefined;
      if (parsed.data.credentialRef !== undefined) {
        if (!HEADER_NAME.test(credentialHeader)) {
          throw new TaviError("INVALID_INPUT", `invalid credentialHeader ${JSON.stringify(parsed.data.credentialHeader)}`);
        }
        const reference = parsed.data.credentialRef;
        // Operator binding is what stops the model pairing a credential with an
        // arbitrary allowlisted host.
        // An own-property lookup: `credentialHosts["__proto__"]` (or `constructor`,
        // `toString`, …) would resolve through `Object.prototype` and reach the host
        // check as a non-array, throwing an untyped `TypeError` instead of a typed
        // refusal.
        const hostMap = options.credentialHosts;
        const boundHosts = hostMap !== undefined && Object.hasOwn(hostMap, reference) ? hostMap[reference] : undefined;
        if (boundHosts === undefined) {
          throw new TaviError(
            "NOT_AUTHORIZED",
            `credential reference ${reference} is not bound to any host; the operator must bind it ` +
              "(--http-credential-host <ref>=<host>) before it can be sent",
            { details: { credentialRef: reference } },
          );
        }
        if (!hostAllowedWithPort(url, boundHosts)) {
          // The *binding map* is operator configuration, and listing it back tells
          // the model which hosts this credential is good for — a map it can then
          // aim at, and a disclosure the model has no use for. The message
          // names the one binding it needs; the rest stays with
          // the operator's log.
          throw new TaviError(
            "NOT_AUTHORIZED",
            `credential reference ${reference} is not bound to ${describeHost(url)}; the operator can bind it with ` +
              `--http-credential-host ${reference}=${describeHost(url)}`,
            { details: { credentialRef: reference, host: url.hostname } },
          );
        }
        let secret: unknown;
        try {
          secret = await options.secretReader.getSecret(reference);
        } catch (error) {
          // The store's own message can carry a filesystem path; keep that in
          // the operator's log and hand the model a path-free typed error.
          throw new TaviError("UNAVAILABLE", `credential reference ${reference} could not be resolved`, {
            cause: error,
            details: { credentialRef: reference },
          });
        }
        // `null` is the port's declared "absent", but an adapter that returns
        // `undefined` must not become `Bearer undefined` on the wire.
        if (typeof secret !== "string" || secret === "") {
          throw new TaviError(
            "INVALID_INPUT",
            `credential reference ${reference} is not configured; set it with \`tavi credentials set\``,
            { details: { credentialRef: reference } },
          );
        }
        const scheme = parsed.data.credentialScheme ?? DEFAULT_CREDENTIAL_SCHEME;
        const injected = scheme === "" ? secret : `${scheme} ${secret}`;
        // Checked here too, not only for model-supplied headers: a *credential*
        // containing CR, LF or NUL would make `Headers.set` throw a message quoting
        // the secret, and that message reaches the model. A credential with a
        // control character is a credential this tool will not send.
        if (/[\u0000\r\n]/.test(injected)) {
          throw new TaviError(
            "INVALID_INPUT",
            `credential reference ${reference} contains a control character and cannot be sent as a header`,
            { details: { credentialRef: reference } },
          );
        }
        headers.set(credentialHeader, injected);
        sentSecret = secret;
      }

      const method = parsed.data.method ?? "GET";
      // Own the timeout so its timer can be cleared on the success path; an
      // `AbortSignal.timeout` is held for its full duration otherwise, which
      // accumulates across a long-lived daemon.
      const controller = new AbortController();
      const onAbort = (): void => controller.abort(signal.reason);
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("http.request timed out")), timeoutMs);
      const failure = (): TaviError =>
        signal.aborted
          ? new TaviError("CANCELLED", "http.request was cancelled")
          : new TaviError("UNAVAILABLE", `http.request timed out after ${timeoutMs}ms for ${method} ${url.origin}`, {
              details: { host: url.hostname },
            });

      try {
        let response: Response;
        try {
          response = await doFetch(url, {
            method,
            headers,
            ...(parsed.data.body === undefined ? {} : { body: parsed.data.body }),
            signal: controller.signal,
            // A redirect target was never checked against the allowlist, and a
            // 307/308 would re-send the body (and same-origin credentials) to
            // it. Surface the 3xx instead of following it.
            redirect: "manual",
          });
        } catch (error) {
          if (controller.signal.aborted) throw failure();
          // An address refusal (a name that resolved to loopback, a private network
          // or the metadata service) is an authority decision, not an outage.
          if (error instanceof TaviError && error.code === "NOT_AUTHORIZED") throw error;
          // Never include request headers here: they may carry the credential.
          const reason = errorMessage(error);
          throw new TaviError("UNAVAILABLE", `http.request failed for ${method} ${url.origin}${url.pathname}: ${reason}`, {
            details: { host: url.hostname },
          });
        }

        const finalUrl = response.url === "" ? url.toString() : response.url;
        // What a stored credential opened is the person's: a credentialed result is `personal`.
        const credentialed = parsed.data.credentialRef === undefined ? {} : { [TOOL_LABEL_KEY]: { confidentiality: "personal" as const } };
        if (response.status >= 300 && response.status < 400) {
          // Best effort: the body is discarded; one already closed has nothing to cancel.
          await response.body?.cancel().catch(() => undefined);
          return {
            status: response.status,
            ok: false,
            redirected: true,
            location: response.headers.get("location"),
            finalUrl,
            note: "http.request does not follow redirects; re-issue the request against an allowlisted host if intended",
            ...credentialed,
          };
        }

        let read: { bytes: Uint8Array; total: number };
        try {
          read = await readBoundedBody(response, maxBytes, { overflow: "truncate" });
        } catch (error) {
          if (controller.signal.aborted) throw failure();
          throw new TaviError("UNAVAILABLE", `http.request could not read the response body: ${String(error)}`, {
            details: { host: url.hostname },
          });
        }

        const truncated = read.total > maxBytes;
        const contentType = (response.headers.get("content-type") ?? "").slice(0, MAX_HEADER_VALUE_CHARS);
        if (saveTo !== undefined && response.ok && options.saver !== undefined) {
          // A part of a file is not the file: nothing is saved past the cap.
          if (truncated)
            throw new TaviError("UNSUPPORTED", `http.request did not save ${saveTo}: the response is over the ${maxBytes}-byte limit`, {
              details: { host: url.hostname },
            });
          // The body is saved as it came, not redacted: a file that echoes the credential sent is refused instead.
          if (sentSecret !== undefined && Buffer.from(read.bytes).includes(sentSecret))
            throw new TaviError(
              "NOT_AUTHORIZED",
              `http.request did not save ${saveTo}: the response contains the credential it was sent with`,
            );
          // What a remote API answered is untrusted wherever it lands: the managed folder is marked tainted, a host write recorded.
          const fetched = untrustedLabel("web", { confidentiality: parsed.data.credentialRef === undefined ? "public" : "personal" });
          const saved = await options.saver.save(
            saveTo,
            read.bytes,
            context,
            contextLabel === undefined ? fetched : joinLabels(contextLabel, fetched),
            assessedSubjects,
          );
          return {
            status: response.status,
            ok: response.ok,
            contentType,
            headers: safeHeaders(response.headers),
            saved: { path: saved.shown, bytes: read.bytes.byteLength, sha256: sha256Hex(read.bytes) },
            finalUrl,
            ...credentialed,
          };
        }
        // The header side is filtered by `safeHeaders`; the body was returned
        // verbatim, so a host that echoes the request — or any endpoint whose
        // response embeds a credential — put it into the model's context and the
        // durable conversation. Credential *shapes* are removed here; the rest of
        // the body is the data the caller asked for and is left alone.
        return {
          status: response.status,
          ok: response.ok,
          contentType,
          headers: safeHeaders(response.headers),
          body: redactCredentialShapes(new TextDecoder().decode(read.bytes)),
          truncated,
          bytes: read.total,
          finalUrl,
          ...(truncated
            ? { note: `response truncated at ${maxBytes} bytes; the remainder was not read` }
            : saveTo !== undefined
              ? { note: `status ${response.status}: the body is returned, not saved to ${saveTo}` }
              : {}),
          ...credentialed,
        };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    },
  });
}
