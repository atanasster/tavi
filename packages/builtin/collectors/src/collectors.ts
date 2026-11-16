import { createSign } from "node:crypto";

import { z } from "zod";

import {
  type ProjectsFileSchema,
  TaviError,
  type Project,
  type ProjectRepositoryPort,
  type SecretReaderPort,
  type ToolRegistrar,
} from "@tavi/contracts";
import { BodyTooLargeError, isLoopbackHostname, readBoundedBody } from "@tavi/node-kit";

/**
 * Deterministic collector tools.
 *
 * These are the data-acquisition half of the daily brief. Each one calls a
 * provider's API directly with credentials resolved inside the handler, and
 * returns a **bounded, typed summary** — never a raw API dump. Three rules,
 * each learned the hard way:
 *
 *  - **`read-only` effect.** A read (even GA4's `runQuery` POST) must not raise
 *    an approval interrupt: under `tavi serve` nothing can answer one, so an
 *    unattended 07:00 run would suspend forever. The endpoints are
 *    hardcoded per provider — no model-supplied URL — so this is not a hole in
 *    `http.request`'s allowlist, it is a second, narrower door with a fixed
 *    destination.
 *  - **Per-source isolation, including credential resolution.** Each source is
 *    attempted inside its own `try` and a failure becomes that project's
 *    `partial` note. A rotated or mistyped key must cost one section, not the
 *    report. A source that is simply not configured says so, and is
 *    never dispatched against (no `Bearer undefined` request).
 *  - **No filesystem paths in a note.** Notes reach the model and the PDF, so a
 *    note names the source and the reason class, never a path.
 *
 * Bounded output matters twice over: a tool result over 64 KiB becomes a
 * `pending` artifact and suspends the turn (`workflow/tool-output.ts`'s `archiveToolOutput`),
 * so every collector aggregates before returning and `collect.daily` caps the
 * whole document.
 */

/**
 * Ceiling for a *tool result* other than the pipeline document.
 *
 * The runtime turns any result over 64 KiB into a `pending` artifact and suspends
 * the turn (`archiveToolOutput`). For an unattended run that is not a failure but
 * a stall: the read never returns to the model, and only an operator decision
 * releases it. So a tool that renders a variable-size payload bounds the whole
 * serialized result, not merely each item in it.
 */
export const MAX_TOOL_RESULT_BYTES = 60 * 1024;

/**
 * Drop entries until the rendered payload fits the tool-result gate.
 *
 * `drop` removes exactly one entry and returns `false` once nothing removable is
 * left; the caller keeps the shape, and this keeps the loop. Two things make it
 * termination-safe rather than hopeful: `drop` must strictly shrink what `render`
 * measures, and the loop stops when it reports there is nothing left — the same
 * discipline `drainWhileOver` states for the document bound.
 *
 * Returns how many entries were dropped, so the caller can say so: a silently
 * shortened answer is the failure mode this exists to prevent.
 */
export function fitToToolResultBudget(
  render: () => unknown,
  drop: () => boolean,
  note?: (dropped: number) => string,
): { readonly dropped: number; readonly note?: string } {
  let dropped = 0;
  const withNote = (): unknown => {
    const text = dropped === 0 || note === undefined ? undefined : note(dropped);
    return text === undefined ? render() : { ...(render() as Record<string, unknown>), note: text };
  };
  while (Buffer.byteLength(JSON.stringify(withNote())) > MAX_TOOL_RESULT_BYTES) {
    if (!drop()) {
      // Nothing left to drop and it still does not fit — one irreducible field is
      // larger than the gate. Returning it would hand the runtime a result it
      // archives as `pending`, suspending an unattended turn forever, so this
      // fails loudly instead: the caller can narrow the query, and a refusal is
      // an answer where a stalled run is not.
      throw new TaviError("INVALID_INPUT", "the result is too large to return even after trimming; narrow the request", {
        details: { publishable: true },
      });
    }
    dropped += 1;
  }
  const text = dropped === 0 || note === undefined ? undefined : note(dropped);
  return text === undefined ? { dropped } : { dropped, note: text };
}

/**
 * At most this many unreadable ids are named in a tool result.
 *
 * The rest are counted, not listed: an id is up to 64 characters, the list is
 * produced by an un-limited query, and the whole point of this file's bounds is
 * that a *read* must not be able to cross the tool-result gate.
 */
const MAX_REPORTED_UNREADABLE = 10;

/** Name a bounded prefix of the unreadable ids, and count the rest. */
export function boundedIds(ids: readonly string[]): { readonly ids: readonly string[]; readonly more: number } {
  return {
    ids: ids.slice(0, MAX_REPORTED_UNREADABLE),
    more: Math.max(0, ids.length - MAX_REPORTED_UNREADABLE),
  };
}

/** Ceiling for the pipeline document, comfortably under the runtime's 64 KiB gate. */
export const MAX_DOCUMENT_BYTES = 60 * 1024;
/**
 * The notes `boundDocument` adds when it had to cut something, so a reader can
 * tell a short brief from a truncated one. Between them they cover all three
 * cuts it can make: news items, notes, and whole projects. Exported because the
 * tests assert on them, and because the trimming loops are only monotone if each
 * is added at most once per project.
 *
 * Each is best-effort: when the document is within a marker's length of the
 * ceiling the marker is skipped rather than pushing a compliant brief into a
 * refusal. A brief that is slightly short and says nothing beats no brief.
 */
export const NEWS_TRIMMED_NOTE = "news items were trimmed to keep the report under the review gate";
export const NOTES_TRIMMED_NOTE = "notes were trimmed to keep the report under the review gate";
/** Names the project drop, which is otherwise silent in both the PDF and the history row. */
export const omittedNote = (count: number): string =>
  count === 1
    ? "1 project was omitted from this brief to keep it under the review gate"
    : `${count} projects were omitted from this brief to keep it under the review gate`;

const isTrimMarker = (note: string): boolean => note === NEWS_TRIMMED_NOTE || note === NOTES_TRIMMED_NOTE;

/** The `details.reason` that marks a size refusal, so `errorNote` does not call it a provider fault. */
const DOCUMENT_SIZE_REASON = "document_size";

/**
 * A clone target whose arrays are mutable.
 *
 * `ProjectReport`'s arrays are `readonly` because a caller may share them;
 * `boundDocument` trims a `structuredClone`, so it needs a mutable view of that
 * copy rather than a cast at every use site.
 */
type MutableProjectReport = Omit<ProjectReport, "metrics" | "news" | "notes"> & {
  metrics: Metric[];
  news: NewsItem[];
  notes: string[];
};

/**
 * Remove entries from `items` until the document fits or only `floor` entries
 * remain, returning what was removed so the caller can keep an exact running
 * byte size instead of re-serializing the whole document per iteration.
 *
 * Termination here is structural and does not depend on `over()` ever turning
 * false: the loop is bounded by `items.length > floor`, `removeOne` must shrink
 * the array, and the `guard` counter stops it even if a future `removeOne` grows
 * it. That last part makes a hang impossible by construction —
 * a marker re-added its "notes were trimmed" marker *inside* this loop,
 * would keep the array from shrinking, `over()` would stay true, and the single-threaded
 * daemon would hang at 100% CPU instead of refusing. Never add a marker from inside
 * this loop.
 */
function drainWhileOver<T>(items: T[], floor: number, over: () => boolean, removeOne: (items: T[]) => T | undefined): T[] {
  const removed: T[] = [];
  let guard = items.length + 1;
  while (items.length > floor && over() && guard > 0) {
    const before = items.length;
    const gone = removeOne(items);
    guard -= 1;
    if (gone === undefined || items.length >= before) break;
    removed.push(gone);
  }
  return removed;
}
const MAX_ITEMS_PER_FEED = 50;
/** Results one search call may contribute, whatever the provider offers. */
const MAX_ITEMS_PER_SEARCH = 10;
/**
 * The web-search provider for project news.
 *
 * A hardcoded provider host, like every other collector destination: the model
 * never chooses it, and the query is built from the operator's own keywords. The
 * credential comes from the deployment's `news.searchCredentialRef` — a field the
 * schema declares and persists; without this provider the type system would imply a
 * provider that did not exist.
 */
const SEARCH_ENDPOINT = "https://api.tavily.com/search";
const MAX_TITLE_CHARS = 300;
const MAX_URL_CHARS = 2048;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

// ----------------------------------------------------------- project config

type CollectorProject = Project;
/**
 * What the collectors read: the import shape plus anything the *loader* learned
 * while assembling it.
 *
 * `warnings` is deliberately outside `ProjectsFileSchema` — that schema is the
 * `projects.json` import format, and an import file has no business supplying
 * warnings. The loader adds them when the registry holds rows it could not read,
 * so a brief that skipped a project says so instead of looking complete.
 */
export type ProjectsFile = z.infer<typeof ProjectsFileSchema> & { readonly warnings?: readonly string[] };

/**
 * The registry as the collectors consume it: the settings plus every **enabled**
 * project.
 *
 * A deployment with no projects yet is an `INVALID_INPUT` with the command that
 * fixes it, rather than an empty brief that looks like a quiet week — the same
 * "looks fine, is wrong" reasoning that applies to a missing metric.
 */

export async function loadProjects(projects: ProjectRepositoryPort, workspaceId: string): Promise<ProjectsFile> {
  const settings = await projects.getSettings(workspaceId);
  const { projects: configured, unreadable } = await projects.list(workspaceId, { enabledOnly: true });
  if (configured.length === 0) {
    // "Add one" would be the wrong instruction when rows exist and none can be
    // read: the operator would add a duplicate of a project that is already
    // there, and the broken row would stay broken.
    if (unreadable.length > 0) {
      throw new TaviError(
        "INVALID_INPUT",
        `no project could be read: ${unreadable.length} stored row(s) are unreadable (${unreadable.join(", ")}). ` +
          "Repair them with `tavi projects remove <id>` then `tavi projects add`, or restore a backup",
        { details: { projects: 0, unreadable } },
      );
    }
    throw new TaviError("INVALID_INPUT", "no projects are configured: add one with `tavi projects add`", {
      details: { projects: 0 },
    });
  }
  return {
    ...settings,
    // Unreadable rows are carried, not dropped: a brief missing a project looks
    // exactly like a brief for a smaller deployment, so the document says which
    // ones were skipped and how to fix them.
    ...(unreadable.length === 0
      ? {}
      : {
          warnings: [
            `${unreadable.length} project row(s) could not be read and were skipped: ${unreadable.join(", ")}. ` +
              "Repair them with `tavi projects remove <id>` then `tavi projects add`, or restore a backup.",
          ],
        }),
    // The registry's own bookkeeping (`workspaceId`, `enabled`, timestamps) is
    // not part of a project's configuration; dropping it keeps the collector's
    // input exactly what the import file describes.
    projects: configured.map((record) => {
      const { workspaceId: _workspaceId, enabled: _enabled, createdAt: _createdAt, updatedAt: _updatedAt, ...project } = record;
      return project;
    }),
  };
}

// ----------------------------------------------------------------- plumbing

export interface CollectorToolOptions {
  /**
   * The project registry. Required: the collectors have no
   * other source for which projects exist, and a data directory that still holds
   * a `projects.json` is an import source, not a fallback.
   */
  readonly projects: ProjectRepositoryPort;
  readonly dataDirectory: string;
  readonly secretReader: SecretReaderPort;
  /** Test seam. */
  readonly fetchImpl?: typeof fetch;
  /** Test seam. */
  readonly now?: () => Date;
}

/** A source whose credential reference has no value: a configuration gap, not a failure. */
class SourceNotConfiguredError extends Error {
  constructor(message = "credential is not configured") {
    super(message);
    this.name = "SourceNotConfiguredError";
  }
}

function errorNote(source: string, error: unknown): string {
  // A credential read's own message can carry an absolute path, and these notes
  // reach the model, the PDF and Telegram — so only the class of failure travels
  //
  if (error instanceof SourceNotConfiguredError) return `${source} is not configured`;
  if (error instanceof TaviError) {
    // A size refusal is not a provider or credential fault, and reporting it as
    // one would send an operator to rotate a key over a document that is too big.
    if (error.details?.["reason"] === DOCUMENT_SIZE_REASON) return `${source} returned more data than the brief budget allows`;
    // A configuration error keeps its own words. This message is written by this
    // file and is path-free by construction, and it is the one note that tells an
    // operator *what to fix* — collapsing it into "<source> failed" would discard the
    // reason and send them to retry a source that will fail identically forever.
    // `UNAVAILABLE` stays distinct: that one really is the
    // provider's side.
    if (error.code === "INVALID_INPUT" && error.details?.["publishable"] === true) return `${source}: ${error.message}`;
    if (error.code === "UNAVAILABLE") return `${source} is unavailable: the provider or its credential failed`;
    if (error.code === "NOT_AUTHORIZED") return `${source} is not authorized`;
    return `${source} failed`;
  }
  return `${source} failed`;
}

/**
 * Read a credential, keeping the store's own message (which may embed a path)
 * to the operator's log rather than the model's context.
 */
async function readSecret(options: CollectorToolOptions, reference: string): Promise<string> {
  let value: string | null;
  try {
    value = await options.secretReader.getSecret(reference);
  } catch (error) {
    throw new TaviError("UNAVAILABLE", `credential ${reference} could not be resolved`, {
      cause: error,
      details: { credentialRef: reference },
    });
  }
  if (typeof value !== "string" || value === "") {
    throw new SourceNotConfiguredError("the credential is not configured");
  }
  return value;
}

/** Read at most `maxBytes` of a response as text, without buffering it all. */
async function readTextCapped(response: Response, maxBytes = MAX_FEED_BYTES): Promise<string> {
  return new TextDecoder().decode((await readBoundedBody(response, maxBytes, { overflow: "truncate" })).bytes);
}

/** Read at most `maxBytes` of a response and parse JSON, without buffering it all. */
async function readJson(response: Response): Promise<unknown> {
  let bytes: Buffer;
  try {
    ({ bytes } = await readBoundedBody(response, MAX_RESPONSE_BYTES));
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new TaviError("UNAVAILABLE", "provider response exceeded the collector's read cap");
    throw error;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return text === "" ? undefined : JSON.parse(text);
  } catch {
    throw new TaviError("UNAVAILABLE", "provider returned a body that is not JSON");
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The reporting window: yesterday backwards, because today is partial. */
export function periodFor(lookbackDays: number, now: Date): { readonly start: string; readonly end: string } {
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (lookbackDays - 1));
  return { start: isoDate(start), end: isoDate(end) };
}

// ------------------------------------------------------------------- google

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/bigquery.readonly",
].join(" ");

/** Sign a service-account JWT. Exported so a test can prove the key is usable without a network call. */
function buildServiceAccountJwt(serviceAccount: unknown, nowSeconds: number): string {
  // `unknown`, not a cast: a credential file containing `null` parses as valid
  // JSON and would then crash on the first property read with a raw `TypeError`, which
  // `errorNote` can only report as the reason-free "google failed".
  if (
    serviceAccount === null ||
    typeof serviceAccount !== "object" ||
    typeof (serviceAccount as { readonly client_email?: unknown }).client_email !== "string" ||
    typeof (serviceAccount as { readonly private_key?: unknown }).private_key !== "string"
  ) {
    throw configError("the Google credential is not a service-account key");
  }
  const account = serviceAccount as { readonly client_email: string; readonly private_key: string };
  const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({
    iss: account.client_email,
    scope: GOOGLE_SCOPES,
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  })}`;
  return `${signingInput}.${createSign("RSA-SHA256").update(signingInput).sign(account.private_key, "base64url")}`;
}

async function googleAccessToken(options: CollectorToolOptions, reference: string, doFetch: typeof fetch, now: Date): Promise<string> {
  const raw = await readSecret(options, reference);
  let serviceAccount: unknown;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw configError("the Google credential is not valid JSON");
  }
  let assertion: string;
  try {
    assertion = buildServiceAccountJwt(serviceAccount, Math.floor(now.getTime() / 1000));
  } catch (error) {
    // The shape validation inside `buildServiceAccountJwt` throws its own typed
    // refusal, which must keep its specific message (it names the missing field).
    if (error instanceof TaviError) throw error;
    // Anything else is a key that is a string but not usable key material (`""`,
    // a truncated or non-PEM value): `crypto.sign` throws a raw `Error`, which
    // `errorNote` can only report as the reason-free "google failed" with code
    // `UNAVAILABLE`. Typed, and
    // pointed at the credential rather than at a retry. The value is never
    // echoed.
    throw configError(`the Google credential's private key is not usable (${error instanceof Error ? error.name : "unknown"})`);
  }
  const response = await doFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new TaviError("UNAVAILABLE", "the Google token exchange was refused");
  const body = (await readJson(response)) as { access_token?: unknown };
  if (typeof body?.access_token !== "string") throw new TaviError("UNAVAILABLE", "the Google token exchange returned no token");
  return body.access_token;
}

export interface Metric {
  readonly source: string;
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly unit: "count" | "usd" | "position";
  readonly higherIsBetter?: boolean;
}

async function ga4Metrics(
  accessToken: string,
  project: CollectorProject,
  period: { start: string; end: string },
  doFetch: typeof fetch,
): Promise<Metric[]> {
  const property = project.ga4PropertyId ?? "";
  const path = property.startsWith("properties/") ? property : `properties/${property}`;
  const response = await doFetch(`https://analyticsdata.googleapis.com/v1beta/${path}:runReport`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: period.start, endDate: period.end }],
      // `conversions` and `keyEvents` are the same metric: asking for both is a
      // 400 "Found duplicate metrics" (observed live).
      metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "conversions" }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new TaviError("UNAVAILABLE", "the GA4 report was refused");
  const body = (await readJson(response)) as { rows?: { metricValues?: { value?: string }[] }[] };
  const values = body?.rows?.[0]?.metricValues ?? [];
  const at = (index: number): number => Number(values[index]?.value ?? 0);
  return [
    { source: "ga4", key: "sessions", label: "Sessions", value: at(0), unit: "count" },
    { source: "ga4", key: "users", label: "Users", value: at(1), unit: "count" },
    { source: "ga4", key: "conversions", label: "Conversions", value: at(2), unit: "count" },
  ];
}

async function gscMetrics(
  accessToken: string,
  project: CollectorProject,
  period: { start: string; end: string },
  doFetch: typeof fetch,
): Promise<Metric[]> {
  const site = encodeURIComponent(project.gscSiteUrl ?? "");
  const response = await doFetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ startDate: period.start, endDate: period.end, dimensions: ["date"], rowLimit: 25 }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new TaviError("UNAVAILABLE", "the Search Console query was refused");
  const body = (await readJson(response)) as {
    rows?: { clicks?: number; impressions?: number; position?: number }[];
  };
  const rows = body?.rows ?? [];
  const clicks = rows.reduce((total, row) => total + Number(row.clicks ?? 0), 0);
  const impressions = rows.reduce((total, row) => total + Number(row.impressions ?? 0), 0);
  const weighted = rows.reduce((total, row) => total + Number(row.position ?? 0) * Number(row.impressions ?? 0), 0);
  return [
    { source: "gsc", key: "clicks", label: "Search clicks", value: clicks, unit: "count" },
    { source: "gsc", key: "impressions", label: "Search impressions", value: impressions, unit: "count" },
    {
      source: "gsc",
      key: "position",
      label: "Avg. position",
      value: impressions === 0 ? 0 : Number((weighted / impressions).toFixed(1)),
      unit: "position",
      higherIsBetter: false,
    },
  ];
}

async function gcpMetrics(accessToken: string, project: CollectorProject, now: Date, doFetch: typeof fetch): Promise<Metric[]> {
  const gcp = project.gcp;
  if (gcp === undefined) throw new TaviError("INVALID_INPUT", "this project has no Cloud Billing export configured");
  const month = isoDate(now).slice(0, 7).replace("-", "");
  if (!/^\d{6}$/.test(month)) throw new TaviError("INTERNAL", "could not derive the billing month");
  const query = ["SELECT ROUND(SUM(cost), 2) AS cost", `FROM ${gcp.billingTable}`, `WHERE invoice.month = '${month}'`, "LIMIT 1"].join(" ");
  const response = await doFetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(gcp.billingProjectId)}/queries`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ query, useLegacySql: false, maxResults: 10 }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new TaviError("UNAVAILABLE", "the Cloud Billing query was refused");
  const body = (await readJson(response)) as { rows?: { f?: { v?: string }[] }[] };
  const cost = Number(body?.rows?.[0]?.f?.[0]?.v ?? 0);
  return [{ source: "gcp", key: "cost", label: "Cloud cost (MTD)", value: cost, unit: "usd", higherIsBetter: false }];
}

// ------------------------------------------------------------------- stripe

/**
 * Currencies Stripe charges in whole units.
 *
 * `ugx` is deliberately **not** here, although the ISO-4217 list makes it
 * zero-decimal: Stripe's own docs say UGX "transitioned to a zero-decimal
 * currency, but backwards compatibility requires you to represent it as a
 * two-decimal value" — so an amount of 500 is 5 UGX, and treating it as 500
 * over-reports revenue by 100x — the zero-decimal bug in the other direction.
 * `isk`/`huf`/`twd` are absent for the same
 * backwards-compatible reason and take the default /100.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

/**
 * Currencies whose smallest unit is a thousandth (Stripe's "special" set).
 *
 * Zero-decimal-or-100 is a binary that gets these wrong by 10x: 1 000 fils is
 * 1.000 KWD, not 10.00.
 */
const THREE_DECIMAL_CURRENCIES = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
/**
 * The codes this file knows how to scale.
 *
 * An unknown three-letter code scaled /100 and then labelled
 * "revenue is in xyz, not usd" would read as authoritative while being a guess.
 * `currencyScale` returning `undefined` for anything
 * outside these sets is what makes the caller say "I cannot convert this" instead.
 */
const KNOWN_CURRENCIES = new Set([
  ...ZERO_DECIMAL_CURRENCIES,
  ...THREE_DECIMAL_CURRENCIES,
  "usd",
  "eur",
  "gbp",
  "aud",
  "cad",
  "chf",
  "sek",
  "nok",
  "dkk",
  "nzd",
  "sgd",
  "hkd",
  "mxn",
  "brl",
  "inr",
  "pln",
  "czk",
  "zar",
  "aed",
  "ils",
  "try",
  "isk",
  "huf",
  "twd",
  "ugx",
  "thb",
  "php",
  "idr",
  "myr",
  "krw",
  "cny",
  "ron",
  "bgn",
  "hrk",
  "rub",
  "uah",
  "egp",
  "ngn",
  "kes",
  "ghs",
  "mad",
  "pen",
  "ars",
  "clp",
  "cop",
]);

/**
 * How many minor units make one major unit, or `undefined` for a code this does
 * not recognise.
 *
 * `undefined` is deliberate and load-bearing: defaulting a
 * missing or non-string `currency` to `usd` would re-create the exact 100x error
 * the helper exists to fix and make it invisible to the note that is supposed to
 * correct it. A caller must decide what to do about an
 * amount whose unit it does not know.
 */
function currencyScale(currency: unknown): number | undefined {
  const code = String(currency ?? "").toLowerCase();
  if (!/^[a-z]{3}$/.test(code)) return undefined;
  if (!KNOWN_CURRENCIES.has(code)) return undefined;
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 1;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 1000;
  return 100;
}

/**
 * Convert a provider's minor-unit amount to major units, or `NaN` when the
 * currency is absent or unrecognised.
 *
 * ICU/ISO-4217 currencies have two decimal places and Stripe quotes amounts in
 * the smallest unit, so `amount / 100` is right for USD and wrong by 100x for
 * JPY, KRW and the other zero-decimal currencies. A hardcoded `/ 100` that never
 * read `charge.currency` would report an account billing in yen 100 times too small
 * with nothing in the note to say so (a paid JPY 1 000 charge rendered as
 * `revenue = 10`).
 */
export function minorUnitsToMajor(amount: unknown, currency: unknown): number {
  const scale = currencyScale(currency);
  return scale === undefined ? Number.NaN : Number(amount ?? 0) / scale;
}

/** Normalize one price to a monthly major-unit amount. */
export function monthlyAmount(price: unknown, quantity: unknown): number {
  const value = price as
    | { unit_amount?: unknown; currency?: unknown; recurring?: { interval?: unknown; interval_count?: unknown } }
    | undefined;
  // `interval_count` is how many intervals one billing period spans: a
  // `month`/3 price is quarterly, so charging it as monthly over-reports MRR 3×.
  const intervalCount = Number(value?.recurring?.interval_count ?? 1) || 1;
  // Defaults to usd, unlike the charges path: a price's currency is what Stripe
  // quotes the subscription in, this path has always treated an absent one as usd,
  // and changing that here would turn MRR into NaN for an existing deployment.
  const unit = minorUnitsToMajor(value?.unit_amount, value?.currency ?? "usd");
  const interval = value?.recurring?.interval;
  const perInterval = interval === "day" ? 30 : interval === "week" ? 52 / 12 : interval === "year" ? 1 / 12 : 1;
  return (unit * Number(quantity ?? 1) * perInterval) / intervalCount;
}

async function stripeMetrics(
  options: CollectorToolOptions,
  project: CollectorProject,
  period: { start: string; end: string },
  doFetch: typeof fetch,
): Promise<{ metrics: Metric[]; notes: string[] }> {
  const reference = project.stripeCredentialRef;
  if (reference === undefined) throw new SourceNotConfiguredError("this project has no Stripe credential configured");
  const key = await readSecret(options, reference);
  const headers = { authorization: `Bearer ${key}` };
  const subscriptions = await doFetch("https://api.stripe.com/v1/subscriptions?status=all&limit=100&expand[]=data.items.data.price", {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!subscriptions.ok) throw new TaviError("UNAVAILABLE", "the Stripe subscriptions query was refused");
  const body = (await readJson(subscriptions)) as {
    data?: { status?: string; canceled_at?: number | null; items?: { data?: { price?: unknown; quantity?: unknown }[] } }[];
    has_more?: boolean;
  };
  const rows = body?.data ?? [];
  const startMs = Date.parse(`${period.start}T00:00:00Z`);
  const endMs = Date.parse(`${period.end}T23:59:59Z`);
  let mrr = 0;
  let churned = 0;
  for (const subscription of rows) {
    if (subscription.status === "active" || subscription.status === "trialing" || subscription.status === "past_due") {
      for (const item of subscription.items?.data ?? []) mrr += monthlyAmount(item.price, item.quantity);
    }
    const canceledAt =
      subscription.canceled_at === null || subscription.canceled_at === undefined ? undefined : subscription.canceled_at * 1000;
    if (canceledAt !== undefined && canceledAt >= startMs && canceledAt <= endMs) churned += 1;
  }
  // Charges are the revenue signal for an account that bills per-payment rather
  // than by subscription — the live account this was built against has real
  // charges and invoices but no subscriptions at all.
  const charges = await doFetch("https://api.stripe.com/v1/charges?limit=100", {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const notes: string[] = [];
  let revenue: number | undefined;
  if (!charges.ok) {
    // A failed call must not render as `$0`: a missing number is honest, a
    // confident zero is the "looks fine, is wrong" failure.
    notes.push("stripe: the charges query failed, so paid revenue is unavailable");
  } else {
    const chargeBody = (await readJson(charges)) as {
      data?: { paid?: boolean; amount?: number; currency?: string; created?: number }[];
      has_more?: boolean;
    };
    // Grouped by currency, never summed across them: adding yen to dollars
    // produces a number that is not money in any currency, and the metric has one
    // `usd` slot to put it in.
    const totals = new Map<string, number>();
    let unreadable = 0;
    for (const charge of chargeBody?.data ?? []) {
      const created = Number(charge.created ?? 0) * 1000;
      if (charge.paid !== true || created < startMs || created > endMs) continue;
      const major = minorUnitsToMajor(charge.amount, charge.currency);
      const code = String(charge.currency ?? "").toLowerCase();
      if (Number.isNaN(major)) {
        unreadable += 1;
        continue;
      }
      totals.set(code, (totals.get(code) ?? 0) + major);
    }
    if (unreadable > 0) {
      notes.push(
        `stripe: ${unreadable} paid charge(s) were excluded because their currency was missing or unrecognised, ` +
          "so revenue is a lower bound",
      );
    }
    const present = [...totals.keys()].sort();
    const only = present.length === 1 ? present[0] : undefined;
    if (only !== undefined) {
      revenue = Number((totals.get(only) ?? 0).toFixed(2));
    } else if (present.length > 1) {
      // No combined figure: a single `usd` metric cannot be the sum of several
      // currencies, and reporting one would be a number with no unit.
      notes.push(
        `stripe: paid revenue spans ${present.join(", ")}, so no single total is reported — ` + "the metrics' unit field is fixed at usd",
      );
    }
    // The metric's `unit` is a fixed enum that only has `usd`, so a non-USD account
    // is scaled correctly but *labelled* wrongly. Saying so is the honest half:
    // an operator reading a yen figure as dollars is a different error from the
    // 100x one this helper fixed, and equally invisible.
    if (only !== undefined && only !== "usd") {
      notes.push(`stripe: revenue is in ${only}, not usd (the metric's unit field is fixed)`);
    }
    if (chargeBody?.has_more === true) {
      notes.push("stripe charges: revenue covers the first 100 rows only, so it is a lower bound");
    }
  }
  if (body?.has_more === true) {
    notes.push("stripe subscriptions: totals cover the first 100 rows only, so they are a lower bound");
  }
  if (rows.length === 0) {
    notes.push("stripe: this account has no subscriptions; MRR and churn are genuinely zero");
  }
  return {
    metrics: [
      { source: "stripe", key: "mrr", label: "MRR", value: Number(mrr.toFixed(2)), unit: "usd" },
      ...(revenue === undefined ? [] : [{ source: "stripe", key: "revenue", label: "Paid revenue", value: revenue, unit: "usd" as const }]),
      { source: "stripe", key: "churn", label: "Churned subs", value: churned, unit: "count", higherIsBetter: false },
    ],
    notes,
  };
}

// --------------------------------------------------------------------- news

/**
 * Drop markup from feed text, in one linear pass.
 *
 * `/<[^>]+>/g` on a string of `<` with no `>` consumes to the end and retries from
 * every position — O(n^2) on hostile text — and merely bounding the tag body
 * (`{1,2048}`) still cost 2048 steps per position: 1.4 seconds on 400 000 `<`
 * characters. Jumping from `<` to the next `>` with
 * `indexOf` is one step per tag, and a `<` with no `>` after it ends the scan.
 */
function stripTags(value: unknown): string {
  const text = String(value ?? "").replace(/<!\[CDATA\[|\]\]>/g, "");
  let out = "";
  let index = 0;
  for (;;) {
    const open = text.indexOf("<", index);
    if (open === -1) {
      out += text.slice(index);
      break;
    }
    out += `${text.slice(index, open)} `;
    const close = text.indexOf(">", open + 1);
    if (close === -1) break;
    index = close + 1;
  }
  return out
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export interface NewsItem {
  readonly title: string;
  readonly url: string;
  readonly source: string;
  readonly publishedAt?: string;
  readonly snippet?: string;
}

/** Minimal RSS/Atom reader — enough for a bounded brief, deliberately not a feed parser. */
/**
 * Split a feed into its item/entry blocks in one linear pass.
 *
 * `/<(item|entry)\b[\s\S]*?<\/\1>/gi` is lazy, so every opening tag with no
 * matching close makes the engine scan the entire rest of the document: a 2 MiB
 * feed of `<item>` lines (inside `MAX_FEED_BYTES`) costs O(tags x length), which
 * stalls the single-threaded daemon rather than slowing one request. Each search here starts where the last block ended, so the total work is
 * linear, and an unterminated tag simply ends the scan.
 */
/**
 * Find the next `<item …>`/`<entry …>` open tag at or after `from`, in linear time.
 *
 * `/<(item|entry)\b[^>]*>/g` looks linear but is not: when the document holds many
 * `<item` prefixes and no `>`, `[^>]*` scans to the end for every start position —
 * 160 KB of repeated `<item` measured ~2 s and scales quadratically, and
 * `MAX_FEED_BYTES` allows 2 MiB, which is minutes of a blocked event loop per
 * source. `indexOf` advances monotonically, so
 * the whole scan is one pass.
 */
function findOpenTag(xml: string, from: number): { readonly index: number; readonly tag: string; readonly end: number } | undefined {
  let cursor = from;
  for (;;) {
    const index = xml.indexOf("<", cursor);
    if (index === -1) return undefined;
    const tag = xml.startsWith("item", index + 1) ? "item" : xml.startsWith("entry", index + 1) ? "entry" : undefined;
    if (tag !== undefined) {
      const boundary = xml[index + 1 + tag.length] ?? "";
      // A tag name ends at a boundary; `<items>` and `<entryway>` are not matches.
      if (boundary === "" || boundary === ">" || boundary === "/" || /\s/.test(boundary)) {
        const close = xml.indexOf(">", index + 1 + tag.length);
        // No `>` anywhere later: the rest of the document is one truncated tag.
        if (close === -1) return undefined;
        return { index, tag, end: close + 1 };
      }
    }
    cursor = index + 1;
  }
}

function feedBlocks(xml: string): string[] {
  const blocks: string[] = [];
  /**
   * Tags for which a close search from some position found nothing.
   *
   * A failed search scanned to the end of the document and proved there is no
   * close tag for that name anywhere after it, so later opens of the same name skip
   * the search entirely — without this, `continue`-ing past each unmatched open tag
   * rescans the whole document per tag, which is the O(tags x length) this function
   * exists to remove (the two requirements pull against each other: skipping must
   * not stop the scan, and continuing must not rescan).
   */
  const exhausted = new Set<string>();
  let cursor = 0;
  for (;;) {
    const tag = findOpenTag(xml, cursor);
    if (tag === undefined) break;
    if (exhausted.has(tag.tag)) {
      cursor = tag.end;
      continue;
    }
    const close = new RegExp(`</${tag.tag}\\s*>`, "gi");
    close.lastIndex = tag.end;
    const end = close.exec(xml);
    if (end === null) {
      // No close for this one — a `<item>` inside a comment or CDATA, or a
      // truncated document. Keep looking for *later* blocks (a `break`
      // here would silently drop every later block), but remember that this tag name has no close left.
      exhausted.add(tag.tag);
      cursor = tag.end;
      continue;
    }
    blocks.push(xml.slice(tag.index, end.index + end[0].length));
    cursor = end.index + end[0].length;
  }
  return blocks;
}

/**
 * The text between one tag and its close, in linear time.
 *
 * `<tag\b[^>]*>([\s\S]*?)</tag>` is lazy, so a block with an opening tag and no
 * close rescans the block: a single 1.4 MiB block took 40 seconds on this
 * function. Both searches below are anchored and the
 * close search starts where the open one ended, so the cost is one pass per tag.
 */
function pickTag(block: string, tag: string): string | undefined {
  // `indexOf`-based for the same reason `findOpenTag` is: a
  // `<${tag}\b[^>]*>` scan walks to the end of the block for every `<${tag}`
  // prefix when no `>` follows, and one block can carry thousands of them.
  let cursor = 0;
  let open = -1;
  for (;;) {
    const index = block.indexOf(`<${tag}`, cursor);
    if (index === -1) return undefined;
    const boundary = block[index + 1 + tag.length] ?? "";
    if (boundary === "" || boundary === ">" || boundary === "/" || /\s/.test(boundary)) {
      open = index;
      break;
    }
    cursor = index + 1;
  }
  const openEnd = block.indexOf(">", open + 1 + tag.length);
  if (openEnd === -1) return undefined;
  const close = new RegExp(`</${tag}\\s*>`, "i");
  close.lastIndex = openEnd + 1;
  const end = close.exec(block);
  return end === null ? undefined : block.slice(openEnd + 1, end.index);
}

/**
 * The `href` of an Atom `<link>` in a block, found with `indexOf`.
 *
 * The regex this replaces has the same backtracking shape as the open-tag
 * searches: a block of `<link` prefixes with no `>` costs O(n²), and this fallback
 * is reached precisely when a block has a `<link>` tag with no text content.
 */
function linkHref(block: string): string {
  let cursor = 0;
  for (;;) {
    const index = block.indexOf("<link", cursor);
    if (index === -1) return "";
    const boundary = block[index + 5] ?? "";
    if (boundary === "" || boundary === ">" || boundary === "/" || /\s/.test(boundary)) {
      const tagEnd = block.indexOf(">", index + 5);
      if (tagEnd === -1) return "";
      const href = block.indexOf('href="', index + 5);
      if (href === -1 || href >= tagEnd) return "";
      const closing = block.indexOf('"', href + 6);
      return closing === -1 ? "" : block.slice(href + 6, closing);
    }
    cursor = index + 1;
  }
}

export function parseFeed(xml: string, feedUrl: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const block of feedBlocks(xml)) {
    const pick = (tag: string): string | undefined => pickTag(block, tag);
    let link = stripTags(pick("link"));
    if (link === "") link = linkHref(block);
    const title = stripTags(pick("title"));
    if (title === "" || link === "") continue;
    let source = feedUrl;
    try {
      source = new URL(link, feedUrl).hostname;
    } catch {
      /* keep the feed URL */
    }
    const publishedAt = stripTags(pick("pubDate") ?? pick("updated") ?? pick("published")).slice(0, 40);
    const snippet = stripTags(pick("description") ?? pick("summary")).slice(0, 280);
    // Only a real http(s) destination: a `javascript:`/`data:` link from a
    // hostile feed would otherwise flow into the model and the PDF renderer.
    if (!/^https?:\/\//i.test(link)) continue;
    items.push({
      title: title.slice(0, MAX_TITLE_CHARS),
      url: link.slice(0, MAX_URL_CHARS),
      source,
      ...(publishedAt === "" ? {} : { publishedAt }),
      ...(snippet === "" ? {} : { snippet }),
    });
  }
  return items;
}

/** Title hits weigh more than snippet hits; a zero score means "not about this project". */
export function relevance(item: NewsItem, keywords: readonly string[]): number {
  const title = item.title.toLowerCase();
  const body = `${item.snippet ?? ""} ${item.url}`.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    if (title.includes(needle)) score += 3;
    if (body.includes(needle)) score += 1;
  }
  return score;
}

/**
 * One search call for one project's keywords.
 *
 * Provider shape: Tavily's `/search` (a bearer key, a query, a result array of
 * `{title, url, content, published_date}`). Results are treated exactly like feed
 * items — untrusted text, https-only, capped, and filtered for relevance to the
 * project — so a search provider cannot smuggle anything a hostile feed could not.
 */
async function searchNews(
  options: CollectorToolOptions,
  reference: string,
  keywords: readonly string[],
  limit: number,
  doFetch: typeof fetch,
): Promise<{ items: NewsItem[]; notes: string[] }> {
  if (keywords.length === 0) return { items: [], notes: [] };
  // Through `readSecret`, like every other collector: it keeps a store message
  // that may embed a filesystem path out of the model's context, and turns "the
  // store threw" into a typed refusal. A bare `getSecret` here would make a throwing
  // credential store fail the whole brief and leak the path to the model.
  let key: string;
  try {
    key = await readSecret(options, reference);
  } catch (error) {
    // `errorNote` never lets a path through: it maps the failure to a class
    // ("is not configured", "is not authorized", "is unavailable"), and this note
    // reaches the model, the PDF and Telegram.
    return { items: [], notes: [errorNote("news: the configured search credential", error)] };
  }
  try {
    const response = await doFetch(SEARCH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        // The operator's keywords, joined as a disjunction: the provider's own
        // ranking is better than anything this file could do with a raw sentence.
        query: keywords.slice(0, 8).join(" OR "),
        max_results: Math.min(limit, MAX_ITEMS_PER_SEARCH),
        search_depth: "basic",
        include_answer: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // No redirects: the destination is hardcoded, and following one would let a
      // provider move the request (and the bearer key) somewhere else.
      redirect: "error",
    });
    if (!response.ok) {
      // 401/403 is a credential problem the operator can fix, and saying
      // "unavailable" for it made a rejected key look like a provider outage.
      if (response.status === 401 || response.status === 403) {
        return { items: [], notes: ["news: the search provider rejected the configured credential"] };
      }
      throw new Error(`HTTP ${response.status}`);
    }
    // Bounded like every other provider read: `response.json()` buffers whatever
    // the provider sends, which a 200 MB body turns into ~865 MB of RSS.
    const parsed = JSON.parse(await readTextCapped(response, MAX_RESPONSE_BYTES)) as { results?: unknown };
    const results = Array.isArray(parsed.results) ? parsed.results.slice(0, MAX_ITEMS_PER_SEARCH) : [];
    const items: NewsItem[] = [];
    for (const entry of results) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as { title?: unknown; url?: unknown; content?: unknown; published_date?: unknown };
      const title = typeof record.title === "string" ? stripTags(record.title).trim() : "";
      const link = typeof record.url === "string" ? record.url : "";
      // https only, unlike a configured feed (which may be a loopback http URL):
      // the provider is a public host and a plain-http result would downgrade a
      // link the report hands to a reader.
      if (title === "" || !/^https:\/\//i.test(link)) continue;
      const snippet = typeof record.content === "string" ? stripTags(record.content).trim() : "";
      const publishedAt = typeof record.published_date === "string" ? record.published_date.slice(0, 40) : "";
      items.push({
        title: title.slice(0, MAX_TITLE_CHARS),
        url: link.slice(0, MAX_URL_CHARS),
        source: "search",
        ...(publishedAt === "" ? {} : { publishedAt }),
        ...(snippet === "" ? {} : { snippet: snippet.slice(0, 280) }),
      });
    }
    return { items, notes: [] };
  } catch {
    // Per-source isolation, the same rule the feeds follow: one dead provider
    // costs a section, not the report.
    return { items: [], notes: ["news: the search provider was unavailable"] };
  }
}

async function newsItems(
  options: CollectorToolOptions,
  projects: ProjectsFile,
  project: CollectorProject,
  limit: number,
  doFetch: typeof fetch,
): Promise<{ items: NewsItem[]; notes: string[] }> {
  const keywords = project.keywords ?? [];
  const notes: string[] = [];
  const candidates: NewsItem[] = [];
  for (const feed of projects.news?.feedUrls ?? []) {
    try {
      // A feed URL comes from configuration, not from the model — the one place
      // this tool's destination is not a hardcoded provider host. It is still
      // held to https, to no redirect, and to a bounded read.
      const url = new URL(feed);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
        throw new Error("feed is not https");
      }
      const response = await doFetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "manual" });
      if (response.status >= 300 && response.status < 400) throw new Error("feed redirected");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      candidates.push(...parseFeed(await readTextCapped(response), feed).slice(0, MAX_ITEMS_PER_FEED));
    } catch {
      notes.push("news: a configured feed was unavailable");
    }
  }
  const searchRef = projects.news?.searchCredentialRef;
  if (searchRef !== undefined) {
    if (keywords.length === 0) {
      // Said out loud: a project with no keywords gets no search, and "no items"
      // would otherwise look like a provider problem.
      notes.push("news: the search provider is configured but this project has no keywords, so no search was run");
    } else {
      const searched = await searchNews(options, searchRef, keywords, limit, doFetch);
      candidates.push(...searched.items);
      notes.push(...searched.notes);
    }
  }
  const seen = new Set<string>();
  const items = candidates
    .map((item) => ({ item, score: relevance(item, keywords) }))
    .filter(({ item, score }) => {
      if (score === 0 || seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ item }) => item);
  if (items.length === 0 && (projects.news?.feedUrls ?? []).length === 0 && projects.news?.searchCredentialRef === undefined) {
    notes.push("news: no feeds or search provider are configured, so no items were collected");
  }
  return { items, notes };
}

// -------------------------------------------------------------------- tools

const ProjectInputSchema = z.object({ projectId: z.string().min(1).max(64) });

/** The Google sources `requireConfigured` gates and `collectProject` dispatches. */
type GoogleSource = "ga4" | "gsc" | "gcp";

/** Shapes a provider path may take. These are model-reachable data. */
const SAFE_PROPERTY_ID = /^(properties\/)?\d{1,20}$/;
const SAFE_SITE_URL = /^(sc-domain:[a-z0-9.*-]{1,253}|https:\/\/[^\s"'<>]{1,2000})$/i;
// A BigQuery table reference as it may legally appear in a FROM clause: an
// optional backtick pair, and the characters a table path carries — including a
// `$` partition decorator (`dataset.table$20260101`) and the legacy
// `project:dataset.table` colon form. Refusing *valid* partitioned tables would make
// a working project silently stop contributing cost to the brief. The injection
// risk is whitespace, an unbalanced backtick and comment characters, not `$` or `:`.
const SAFE_BILLING_TABLE = /^`?[\w.$:-]{1,512}`?$/;
/** GCP project ids are lowercase letters, digits and hyphens. */
const SAFE_GCP_PROJECT_ID = /^[a-z][a-z0-9-]{4,29}$/;

/**
 * A configuration error whose message is written to be **published**.
 *
 * `errorNote` echoes `INVALID_INPUT` messages into the model's context, the PDF,
 * the Telegram message and the recorded history, and this file promises those
 * notes carry no filesystem paths. Echoing every `INVALID_INPUT` made that a
 * convention rather than a guarantee — the next error thrown inside the
 * collectors with a path in its message would travel the whole way. Only a
 * message built here, deliberately, is echoed; anything else falls back to the
 * reason-free form.
 */
function configError(message: string): TaviError {
  return new TaviError("INVALID_INPUT", message, { details: { publishable: true } });
}

/**
 * Refuse a source this project does not configure, before anything is dispatched.
 *
 * Without this, `ga4.report` on a project with no property would call
 * `properties/:runReport` and report the provider's 400 as "the GA4 report was
 * refused" — a lie about a source that was never configured, plus a pointless
 * outbound call. The shape checks matter because the registry stores project data
 * a model helped collect: a table or property id is interpolated into a query
 * and a request path.
 */
function requireConfigured(project: CollectorProject, source: GoogleSource): void {
  if (source === "ga4") {
    if (project.ga4PropertyId === undefined) throw new SourceNotConfiguredError("this project has no GA4 property configured");
    if (!SAFE_PROPERTY_ID.test(project.ga4PropertyId)) {
      throw configError("the GA4 property id is not a GA4 property id");
    }
    return;
  }
  if (source === "gsc") {
    if (project.gscSiteUrl === undefined) throw new SourceNotConfiguredError("this project has no Search Console site configured");
    if (!SAFE_SITE_URL.test(project.gscSiteUrl)) {
      throw configError("the Search Console site is not a site URL or sc-domain property");
    }
    return;
  }
  if (project.gcp === undefined) throw new SourceNotConfiguredError("this project has no Cloud Billing export configured");
  if (!SAFE_BILLING_TABLE.test(project.gcp.billingTable)) {
    throw configError("the Cloud Billing export table is not a table reference");
  }
  // Both halves of the pair are interpolated — the table into SQL, the project id
  // into the request *path* — so both are checked. `encodeURIComponent`
  // leaves `.` alone, so `billingProjectId: ".."` would normalize the URL to a
  // different endpoint than the source intended.
  if (!SAFE_GCP_PROJECT_ID.test(project.gcp.billingProjectId)) {
    throw configError("the Cloud Billing project id is not a Google Cloud project id");
  }
}

/**
 * Whether a source counts as configured, using the same gate the collectors use.
 *
 * A malformed id is reported `false` rather than thrown: this answers a question
 * about a registry, and refusing to answer it would tell the caller less than a
 * plain "not configured" does.
 */
function sourceConfigured(project: CollectorProject, source: GoogleSource): boolean {
  try {
    requireConfigured(project, source);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the shared Google credential, treating an absent reference as "not configured". */
async function googleTokenFor(options: CollectorToolOptions, projects: ProjectsFile, doFetch: typeof fetch, date: Date): Promise<string> {
  const reference = projects.googleServiceAccountRef;
  if (reference === undefined) throw new SourceNotConfiguredError("the Google service-account credential is not configured");
  return googleAccessToken(options, reference, doFetch, date);
}

export interface ProjectReport {
  readonly id: string;
  readonly name: string;
  readonly metrics: readonly Metric[];
  readonly news: readonly NewsItem[];
  readonly notes: readonly string[];
}

/**
 * The refusal for a project id the registry does not hold.
 *
 * The model guesses ids — a domain, a product name — and a bare "not configured"
 * left it with nothing to act on (the chat asked about a site no project covers,
 * got this, and gave up). The configured ids and the general-purpose path are
 * the two facts that let it recover in one step, and the wording is directive
 * because a smaller model reads "use web_search" as a proposal to put to the
 * operator rather than a call to make. Shared by the two ways a lookup fails:
 * an id that is not among the configured projects, and a registry with none.
 */
function unknownProjectError(source: string, projectId: string, configured: readonly string[]): TaviError {
  const listed = configured.length === 0 ? "no projects are configured" : `configured projects: ${configured.join(", ")}`;
  return new TaviError(
    "INVALID_INPUT",
    `no project ${JSON.stringify(projectId)} is configured (${listed}). This is not a ${source} question: ` +
      "call web_search with the operator's request now, without asking first — the request already covers it",
    { details: { projectId, configuredProjectIds: configured } },
  );
}

async function projectById(projects: ProjectsFile, projectId: string, source = "news.search"): Promise<CollectorProject> {
  const project = await projects.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    throw unknownProjectError(source, projectId, await projects.projects.map((candidate) => candidate.id));
  }
  return project;
}

/** Collect every source for one project, isolating each failure as a note. */
async function collectProject(
  options: CollectorToolOptions,
  projects: ProjectsFile,
  project: CollectorProject,
  doFetch: typeof fetch,
  now: Date,
  lookbackDays: number,
): Promise<ProjectReport> {
  const period = periodFor(lookbackDays, now);
  const metrics: Metric[] = [];
  const notes: string[] = [];

  const googleSources: [GoogleSource, (token: string) => Promise<Metric[]>][] = [
    ["ga4", (token) => ga4Metrics(token, project, period, doFetch)],
    ["gsc", (token) => gscMetrics(token, project, period, doFetch)],
    ["gcp", (token) => gcpMetrics(token, project, now, doFetch)],
  ];
  // The *same* gate the per-source tools use, applied before anything is
  // interpolated into a query or a URL. Selecting sources by presence alone would
  // let a malformed `billingTable` reach BigQuery while `gcp.billing`
  // refused the identical project, so the two entry points would disagree about what
  // "configured" means and only one of them would be safe.
  //
  // A source that is merely absent is skipped silently (that is what "not
  // configured" means for a partially-configured project); a source that is
  // *present but malformed* becomes a note, so the brief degrades and says why
  // instead of failing the whole run or issuing a bad request.
  const configuredGoogle: typeof googleSources = [];
  for (const entry of googleSources) {
    try {
      requireConfigured(project, entry[0]);
      configuredGoogle.push(entry);
    } catch (error) {
      if (!(error instanceof SourceNotConfiguredError)) notes.push(errorNote(entry[0], error));
    }
  }
  if (configuredGoogle.length > 0) {
    try {
      const token = await googleTokenFor(options, projects, doFetch, now);
      for (const [name, collect] of configuredGoogle) {
        try {
          metrics.push(...(await collect(token)));
        } catch (error) {
          notes.push(errorNote(name, error));
        }
      }
    } catch (error) {
      // One note for the whole group: a missing shared credential is one
      // configuration gap, not three identical failures.
      notes.push(errorNote("google", error));
    }
  }

  try {
    const stripe = await stripeMetrics(options, project, period, doFetch);
    metrics.push(...stripe.metrics);
    notes.push(...stripe.notes);
  } catch (error) {
    notes.push(errorNote("stripe", error));
  }

  const news = await newsItems(options, projects, project, projects.news?.maxItemsPerProject ?? 8, doFetch);
  notes.push(...news.notes);

  return {
    id: project.id,
    name: project.name ?? project.id,
    metrics,
    news: news.items,
    notes,
  };
}

/**
 * Keep the pipeline document under the runtime's review gate.
 *
 * Trimming news alone is not enough: the project schema allows 50 projects, and
 * a fully configured project's metrics and notes can exceed the budget on their
 * own. So this trims news, then notes, then drops whole projects, and finally
 * **refuses** rather than handing the runtime a document that would become a
 * `pending` artifact and suspend an unattended run forever. It works on a
 * copy, so a caller's arrays are never mutated.
 *
 * Termination does **not** depend on `over()` ever turning false: every loop goes
 * through `drainWhileOver`, which pairs a length floor with a strict decrement and
 * an independent guard, so it exits even when the document cannot be made to fit.
 * The size is *not* monotone across passes — each marker add costs bytes after its
 * pass has stopped trimming — so the trim predicates reserve the marker's cost
 * before deciding the document fits, and a marker that still cannot fit is skipped
 * rather than allowed to force a refusal. Do not add a marker from inside a loop:
 * that would hang the daemon at 100% CPU instead of
 * refusing, and no in-process test can fail fast on it.
 *
 * Notes are dropped from the end and the trim markers are never dropped at all,
 * so the earliest notes — the reasons the collectors emit first — survive longest
 * and a reader always learns *what* was cut. A dropped project is named on the
 * first surviving project's notes, because that is the channel the PDF and the
 * history row both render.
 */
export function boundDocument<T extends { projects: ProjectReport[] }>(
  document: T,
  options: { readonly protectedNotes?: readonly string[] } = {},
): T {
  let bytes = Buffer.byteLength(JSON.stringify(document));
  if (bytes <= MAX_DOCUMENT_BYTES) return document;
  const bounded = structuredClone(document) as T;
  /**
   * Notes the caller considers load-bearing — currently the loader's
   * "N project rows could not be read" warning.
   *
   * They are attached last, so an unguarded trim would evict them first and a
   * reader would learn only that "notes were trimmed", never that a project was
   * missing. They are still strippable by the final fallback below: annotation
   * must never be the reason a compliant brief is refused.
   */
  const protectedNotes = new Set(options.protectedNotes ?? []);
  const isProtected = (note: string): boolean => isTrimMarker(note) || protectedNotes.has(note);
  // The single cast: the trims mutate this clone, never the caller's arrays.
  const projects = bounded.projects as MutableProjectReport[];

  /**
   * The exact byte cost of one array's JSON, so a mutation's effect is a
   * difference rather than an assumption.
   *
   * A flat `+1` per element for the separating comma would be wrong at the
   * empty-array boundary in both directions: emptying a one-element array removes
   * no comma and pushing the first note into an empty array adds none, so the
   * running total would drift by a byte per emptied array and the trim predicate
   * could stop one iteration early — an avoidable refusal, or an avoidable strip
   * of the caller's protected notes.
   */
  const arrayBytes = (value: readonly unknown[]): number => Buffer.byteLength(JSON.stringify(value) ?? "[]");
  const over = (): boolean => bytes > MAX_DOCUMENT_BYTES;
  /**
   * Every annotation this function adds, in insertion order (least important
   * first: news marker, notes marker, project-omission notice).
   *
   * They exist to make truncation visible, so they are added eagerly and counted
   * in `bytes` — the trim predicates reserve them, so a pass stops only once the
   * document *including* its marker fits. If the document is somehow still over at
   * the end they are stripped in this order and re-measured: an annotation is
   * never allowed to be the reason a compliant brief is refused.
   */
  const annotations: { readonly project: MutableProjectReport; text: string }[] = [];
  const addNote = (project: MutableProjectReport, text: string): void => {
    if (project.notes.includes(text)) return;
    const before = arrayBytes(project.notes);
    project.notes.push(text);
    bytes += arrayBytes(project.notes) - before;
    annotations.push({ project, text });
  };
  /** Reserve the marker's own bytes while trimming, so the last trim decision accounts for it. */
  const overWithNote = (project: MutableProjectReport, text: string): boolean =>
    project.notes.includes(text) ? over() : bytes + arrayBytes([...project.notes, text]) - arrayBytes(project.notes) > MAX_DOCUMENT_BYTES;

  for (const project of projects) {
    const before = arrayBytes(project.news);
    const removed = drainWhileOver(
      project.news,
      0,
      () => overWithNote(project, NEWS_TRIMMED_NOTE),
      (items) => items.pop(),
    );
    if (removed.length === 0) continue;
    bytes += arrayBytes(project.news) - before;
    addNote(project, NEWS_TRIMMED_NOTE);
  }

  for (const project of projects) {
    // The markers are part of the floor, not candidates for removal: the news
    // marker sits at the tail, so an unguarded "drop the last note" would evict
    // the news signal and misattribute the truncation to notes.
    const markers = project.notes.filter(isProtected).length;
    const before = arrayBytes(project.notes);
    const removed = drainWhileOver(
      project.notes,
      markers + 1,
      () => overWithNote(project, NOTES_TRIMMED_NOTE),
      (items) => {
        const index = items.findLastIndex((note) => !isProtected(note));
        return index === -1 ? undefined : items.splice(index, 1)[0];
      },
    );
    if (removed.length === 0) continue;
    bytes += arrayBytes(project.notes) - before;
    addNote(project, NOTES_TRIMMED_NOTE);
  }

  // The drop is the largest truncation this function can make and the only one
  // with no per-project note to hang a signal on, so reserve the notice's bytes
  // (upper-bounded by the largest possible count) before deciding what to drop.
  const omissionHost = over() && projects.length > 1 ? projects[0] : undefined;
  const reserved = omissionHost === undefined ? undefined : omittedNote(projects.length - 1);
  if (omissionHost !== undefined && reserved !== undefined) {
    // Not via `addNote`: the text is replaced below, so it is recorded as an
    // annotation only once its final form is known.
    const beforeReserved = arrayBytes(omissionHost.notes);
    omissionHost.notes.push(reserved);
    bytes += arrayBytes(omissionHost.notes) - beforeReserved;
  }
  const projectsBefore = arrayBytes(projects);
  const dropped = drainWhileOver(projects, 1, over, (items) => items.pop());
  bytes += arrayBytes(projects) - projectsBefore;
  if (omissionHost !== undefined && reserved !== undefined) {
    // The real count is never larger than the reserved one, and never has more
    // digits, so the replacement cannot cross the ceiling.
    const finalText = omittedNote(dropped.length);
    const index = omissionHost.notes.indexOf(reserved);
    if (index !== -1) {
      const before = arrayBytes(omissionHost.notes);
      omissionHost.notes[index] = finalText;
      bytes += arrayBytes(omissionHost.notes) - before;
      annotations.push({ project: omissionHost, text: finalText });
    }
  }

  if (Buffer.byteLength(JSON.stringify(bounded)) > MAX_DOCUMENT_BYTES) {
    // Trim markers first, then the caller's protected notes: each is an
    // annotation, and an annotation must never be the reason a compliant brief
    // is refused. Losing the note is a smaller failure than losing the brief.
    for (const annotation of annotations) {
      const index = annotation.project.notes.indexOf(annotation.text);
      if (index !== -1) annotation.project.notes.splice(index, 1);
      if (Buffer.byteLength(JSON.stringify(bounded)) <= MAX_DOCUMENT_BYTES) break;
    }
    if (Buffer.byteLength(JSON.stringify(bounded)) > MAX_DOCUMENT_BYTES) {
      for (const project of projects) {
        for (const note of [...protectedNotes]) {
          const index = project.notes.indexOf(note);
          if (index !== -1) project.notes.splice(index, 1);
          if (Buffer.byteLength(JSON.stringify(bounded)) <= MAX_DOCUMENT_BYTES) break;
        }
        if (Buffer.byteLength(JSON.stringify(bounded)) <= MAX_DOCUMENT_BYTES) break;
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(bounded)) > MAX_DOCUMENT_BYTES) {
    throw new TaviError("UNAVAILABLE", "the daily brief document exceeded its size budget", {
      details: { reason: DOCUMENT_SIZE_REASON },
    });
  }
  return bounded;
}

export interface DailyBrief {
  readonly generatedAt: string;
  readonly period: { readonly start: string; readonly end: string };
  readonly projects: ProjectReport[];
}

/**
 * Collect every configured project's data into one bounded document.
 *
 * Shared by the `collect.daily` tool and the report pipeline (`reports.generate`),
 * so the two can never disagree about what a daily brief contains.
 */
export async function collectDaily(
  options: CollectorToolOptions,
  input: { readonly projectIds?: readonly string[]; readonly lookbackDays?: number; readonly workspaceId: string },
): Promise<DailyBrief> {
  const doFetch = options.fetchImpl ?? fetch;
  const date = options.now?.() ?? new Date();
  // The caller's workspace, always: no composed default, so no call reads another workspace's projects.
  const projects = await loadProjects(options.projects, input.workspaceId);
  const wanted =
    input.projectIds === undefined
      ? projects.projects
      : await Promise.all(input.projectIds.map(async (id) => await projectById(projects, id)));
  const lookbackDays = input.lookbackDays ?? projects.lookbackDays ?? 7;
  const collected: ProjectReport[] = [];
  for (const project of wanted) {
    collected.push(await collectProject(options, projects, project, doFetch, date, lookbackDays));
  }
  // Rows the registry could not read are named on the first collected project,
  // which is the channel the PDF and the recorded history both render. Dropping
  // them silently would make a brief that skipped a project indistinguishable
  // from a brief for a deployment that has fewer projects.
  const warnings = projects.warnings ?? [];
  if (warnings.length > 0 && collected[0] !== undefined) {
    (collected[0].notes as string[]).push(...warnings);
  }
  return boundDocument(
    {
      generatedAt: date.toISOString(),
      period: periodFor(lookbackDays, date),
      projects: collected,
    },
    { protectedNotes: warnings },
  );
}

export function registerCollectorTools(registry: ToolRegistrar, options: CollectorToolOptions): void {
  const doFetch = options.fetchImpl ?? fetch;
  const now = (): Date => options.now?.() ?? new Date();

  // `projects.get` — the agent's read-only view of which
  // projects exist and how each source is configured. It exists so that an
  // orchestrator that can see the registry can tell the operator what it
  // already knows and ask only for the gaps, instead of interviewing them from
  // nothing. `read-only`, so it never raises an approval in an unattended run.
  registry.register({
    id: "projects.get",
    sink: "none",
    version: "1.0.0",
    description:
      "List the configured projects and which data sources each one has. Reports whether a source is configured, never a credential value or its reference name.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: z.object({ projectId: z.string().min(1).max(64).optional().describe("Limit to this project") }).optional(),
    handler: async ({ input, context }: { input: unknown; context: { readonly workspaceId: string } }) => {
      const parsed = z.object({ projectId: z.string().min(1).max(64).optional() }).safeParse(input ?? {});
      if (!parsed.success) throw new TaviError("INVALID_INPUT", "projects.get received invalid arguments");
      const { projects: all, unreadable } = await options.projects.list(context.workspaceId);
      const wanted = parsed.data.projectId === undefined ? all : all.filter((project) => project.id === parsed.data.projectId);
      if (parsed.data.projectId !== undefined && wanted.length === 0) {
        // An id that exists but cannot be read is a different answer from an id
        // that does not exist, and it is the answer the operator needs: they can
        // see the project in `tavi projects list`, so "not configured" would send
        // them looking for a project they already have.
        if (unreadable.includes(parsed.data.projectId)) {
          throw new TaviError("INVALID_INPUT", `Project ${parsed.data.projectId} exists but its stored row is unreadable`, {
            details: { projectId: parsed.data.projectId, unreadableProjects: [parsed.data.projectId] },
          });
        }
        // An unknown id is a real answer, not an empty list.
        throw new TaviError("NOT_FOUND", `No project ${parsed.data.projectId} is configured`, {
          details: { projectId: parsed.data.projectId },
        });
      }
      const settings = await options.projects.getSettings(context.workspaceId);
      // Every project and all of its keywords is ~200 KiB at the schema's limits —
      // well past the tool-result gate — so the answer is bounded as a whole.
      // Keywords go first (the least important part of an answer about *which*
      // projects exist), then whole projects from the end of the list, and either
      // way the caller is told what was left out rather than shown a shorter
      // registry that looks complete.
      const listed: {
        id: string;
        name: string;
        enabled: boolean;
        sources: { ga4: boolean; gsc: boolean; gcpBilling: boolean; stripe: boolean; news: boolean };
        keywords: string[];
      }[] = wanted.map((project) => ({
        id: project.id,
        name: project.name ?? project.id,
        enabled: project.enabled,
        // Derived from the gate, not from presence: a project whose GA4 property
        // or billing table is malformed is *not* configured, and reporting it as
        // configured is the same "looks fine, is wrong" split the collector paths
        // refuse to make — on the surface the operator is told to trust.
        sources: {
          ga4: sourceConfigured(project, "ga4"),
          gsc: sourceConfigured(project, "gsc"),
          gcpBilling: sourceConfigured(project, "gcp"),
          stripe: project.stripeCredentialRef !== undefined,
          news: (project.keywords?.length ?? 0) > 0,
        },
        keywords: [...(project.keywords ?? [])],
      }));

      const payload = (): unknown => ({
        // The deployment-wide half of the configuration, so a caller can tell
        // "this project has no GA4 id" from "GA4 is not set up at all".
        //
        // A **boolean**, not the reference name: a credential reference is
        // operator naming that the model has no use for, and the rule is
        // that a model learns whether a credential is configured, never its
        // name (the reason `http.request`'s bindings are operator-authored
        // too). This tool's description promises as much.
        googleConfigured: settings.googleServiceAccountRef !== undefined,
        lookbackDays: settings.lookbackDays ?? 7,
        newsFeedCount: settings.news?.feedUrls?.length ?? 0,
        // Whether a search provider is configured at all: without it a deployment
        // could believe it had news search.
        newsSearchConfigured: settings.news?.searchCredentialRef !== undefined,
        // Named so the model can tell the operator *which* projects are missing
        // rather than reporting a list that looks complete — but *bounded*: the
        // ids come from an un-limited `list`, and 50 x 64-character ids measured
        // 137 KiB on their own, which is past the gate before any project is
        // rendered.
        ...(unreadable.length === 0 ? {} : { unreadableProjects: boundedIds(unreadable) }),
        projects: listed,
      });
      const bounded = fitToToolResultBudget(
        payload,
        () => {
          const host = listed.find((entry) => entry.keywords.length > 1);
          if (host !== undefined) {
            host.keywords.pop();
            return true;
          }
          return listed.pop() !== undefined;
        },
        (dropped) =>
          `${dropped} keyword(s) or project(s) were omitted to keep this result under the runtime's tool-result gate; ` +
          "ask for one project with `projects.get { projectId }` to see it in full",
      );
      return bounded.note === undefined ? payload() : { ...(payload() as Record<string, unknown>), note: bounded.note };
    },
  });

  const sources: readonly {
    readonly id: string;
    readonly description: string;
    readonly run: (projects: ProjectsFile, project: CollectorProject, date: Date) => Promise<ProjectReport>;
    /**
     * `none` for the business collectors (fixed
     * endpoints, a `projectId` the only input); `search` for the news search,
     * whose keywords reach the deployment's news provider.
     */
    readonly sink: "none" | "search";
    /**
     * The call's own sink, where it is narrower: `news.search`'s query is
     * the project's configured keywords, and its only input a configured
     * `projectId`, so nothing the model writes reaches the provider — `none`.
     */
    readonly callSink?: "none";
    /** Returns third-party text (headlines, snippets) a page author wrote, which taints the conversation. */
    readonly untrustedOutput?: boolean;
    /** Where an untrusted result came from: the news search's provider. */
    readonly outputSource?: "search";
    /** The business collectors' figures are the person's: `personal`. */
    readonly outputConfidentiality?: "personal";
  }[] = [
    {
      id: "ga4.report",
      sink: "none",
      outputConfidentiality: "personal",
      description: "Google Analytics 4 summary for one configured project: sessions, users and conversions.",
      run: async (projects, project, date) => {
        requireConfigured(project, "ga4");
        return {
          id: project.id,
          name: project.name ?? project.id,
          metrics: await ga4Metrics(
            await googleTokenFor(options, projects, doFetch, date),
            project,
            periodFor(projects.lookbackDays ?? 7, date),
            doFetch,
          ),
          news: [],
          notes: [],
        };
      },
    },
    {
      id: "gsc.query",
      sink: "none",
      outputConfidentiality: "personal",
      description: "Search Console summary for one configured project: clicks, impressions and average position.",
      run: async (projects, project, date) => {
        requireConfigured(project, "gsc");
        return {
          id: project.id,
          name: project.name ?? project.id,
          metrics: await gscMetrics(
            await googleTokenFor(options, projects, doFetch, date),
            project,
            periodFor(projects.lookbackDays ?? 7, date),
            doFetch,
          ),
          news: [],
          notes: [],
        };
      },
    },
    {
      id: "gcp.billing",
      sink: "none",
      outputConfidentiality: "personal",
      description: "Cloud Billing month-to-date cost for one configured project's export table.",
      run: async (projects, project, date) => {
        requireConfigured(project, "gcp");
        return {
          id: project.id,
          name: project.name ?? project.id,
          metrics: await gcpMetrics(await googleTokenFor(options, projects, doFetch, date), project, date, doFetch),
          news: [],
          notes: [],
        };
      },
    },
    {
      id: "stripe.subscriptions",
      sink: "none",
      outputConfidentiality: "personal",
      description: "Stripe MRR, paid revenue and churn for one configured project.",
      run: async (projects, project, date) => {
        const stripe = await stripeMetrics(options, project, periodFor(projects.lookbackDays ?? 7, date), doFetch);
        return { id: project.id, name: project.name ?? project.id, metrics: stripe.metrics, news: [], notes: stripe.notes };
      },
    },
    {
      id: "news.search",
      sink: "search",
      callSink: "none",
      description:
        "Recent news items carrying links for one configured project's keywords, from the deployment's news feeds " +
        "and its news search provider. Only for a project `projects.get` lists; news about any other company, " +
        "product or site is a `web_search` call, made directly rather than proposed. Destinations are " +
        "configuration-supplied, not fixed provider hosts.",
      untrustedOutput: true,
      outputSource: "search",
      run: async (projects, project) => {
        if ((project.keywords ?? []).length === 0) {
          throw new SourceNotConfiguredError("this project has no keywords configured");
        }
        const news = await newsItems(options, projects, project, projects.news?.maxItemsPerProject ?? 8, doFetch);
        return { id: project.id, name: project.name ?? project.id, metrics: [], news: news.items, notes: news.notes };
      },
    },
  ];

  // Offered only where a project exists to read. A per-project source in a
  // workspace with none is a tool the model can only misfire on: a chat about an
  // unregistered site reached for `news.search`, spent a turn on the refusal,
  // and relayed it. `projects.get` and `collect.daily` stay offered — the first
  // is how the model learns there is nothing configured, the second reports
  // that in its own words. Enabled rows only, like `loadProjects`; an
  // unreadable row still counts, so the reporting path for it stays reachable.
  const projectsConfigured = async (context: { readonly workspaceId: string }): Promise<boolean> => {
    const listed = await options.projects.list(context.workspaceId, { enabledOnly: true });
    return listed.projects.length > 0 || listed.unreadable.length > 0;
  };

  for (const source of sources) {
    const callSink = source.callSink;
    registry.register({
      id: source.id,
      sink: source.sink,
      version: "1.0.0",
      description: `${source.description} Read-only: the provider endpoint is fixed, not model-supplied.`,
      // A read must not raise an approval interrupt — under `serve` nothing can
      // answer one, so an unattended run would suspend forever.
      effect: "read-only",
      requiredPermissions: ["tools.invoke"],
      offered: projectsConfigured,
      ...(source.untrustedOutput === true ? { untrustedOutput: true } : {}),
      ...(source.outputSource === undefined ? {} : { outputSource: source.outputSource }),
      ...(source.outputConfidentiality === undefined ? {} : { outputConfidentiality: source.outputConfidentiality }),
      ...(callSink === undefined
        ? {}
        : { assess: () => ({ display: { title: `Run ${source.id}` }, subjects: [], risk: "low" as const, reasons: [], sink: callSink }) }),
      inputSchema: ProjectInputSchema,
      handler: async ({ input, context }: { input: unknown; context: { readonly workspaceId: string } }) => {
        const parsed = ProjectInputSchema.safeParse(input);
        if (!parsed.success) {
          throw new TaviError("INVALID_INPUT", `${source.id} received invalid arguments`, {
            details: { issues: parsed.error.issues.map((issue) => issue.message) },
          });
        }
        let projects: ProjectsFile;
        try {
          projects = await loadProjects(options.projects, context.workspaceId);
        } catch (error) {
          // An empty registry answered "add one with `tavi projects add`" — an
          // operator's instruction, delivered to the model, which then asked the
          // operator what to do. For a single-project read it is the same
          // situation as an unknown id, so it gets the same recovery.
          if (
            error instanceof TaviError &&
            error.code === "INVALID_INPUT" &&
            error.details?.["projects"] === 0 &&
            error.details?.["unreadable"] === undefined
          ) {
            throw unknownProjectError(source.id, parsed.data.projectId, []);
          }
          throw error;
        }
        const project = await projectById(projects, parsed.data.projectId, source.id);
        try {
          const report = await source.run(projects, project, now());
          // The loader's warning travels with *every* answer, including a
          // single-project one: otherwise a model asking about a healthy project
          // is told `ok` while another row is unreadable and skipped, which is
          // the silent-loss channel this reporting exists to close.
          const warnings = projects.warnings ?? [];
          return boundDocument(
            { projects: warnings.length === 0 ? [report] : [{ ...report, notes: [...report.notes, ...warnings] }] },
            { protectedNotes: warnings },
          ).projects[0];
        } catch (error) {
          // Every failure leaves as fixed, path-free text: a credential store's
          // own message can embed an absolute path, and a tool error reaches the
          // model verbatim. "Not configured" is the caller's mistake to
          // fix, so it keeps a code the model can act on.
          const message = errorNote(source.id, error);
          // A malformed id is the caller's to fix, exactly like an absent one: both
          // are `INVALID_INPUT`. Reporting a registry typo as `UNAVAILABLE` would send the
          // operator to retry a source that will fail identically forever.
          throw error instanceof SourceNotConfiguredError ||
            // The same predicate `errorNote` uses to decide whether to publish the
            // message: an `INVALID_INPUT` without the `publishable` flag carries a
            // generic note, and classifying it as a *usage* error while showing
            // "<source> failed" would be inconsistent.
            (error instanceof TaviError && error.code === "INVALID_INPUT" && error.details?.["publishable"] === true)
            ? new TaviError("INVALID_INPUT", message)
            : new TaviError("UNAVAILABLE", message);
        }
      },
    });
  }

  registry.register({
    id: "collect.daily",
    sink: "none",
    // Its news items are feed and search text a page author wrote: `routine-output`, untrusted.
    untrustedOutput: true,
    outputSource: "routine-output",
    // The business collectors' figures, all at once: `personal`, as each collector's are.
    outputConfidentiality: "personal",
    version: "1.0.0",
    description:
      "Collect every configured project's analytics, billing, subscription and news data into one bounded summary. " +
      "One call instead of one per project per source; each source degrades to a note.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: z
      .object({
        projectIds: z.array(z.string().min(1).max(64)).max(50).optional().describe("Limit to these projects (default: all)"),
        lookbackDays: z.number().int().min(1).max(90).optional().describe("Reporting window ending yesterday"),
      })
      .optional(),
    handler: async ({ input, context }: { input: unknown; context: { readonly workspaceId: string } }) => {
      const parsed = z
        .object({ projectIds: z.array(z.string()).max(50).optional(), lookbackDays: z.number().int().min(1).max(90).optional() })
        .safeParse(input ?? {});
      if (!parsed.success) throw new TaviError("INVALID_INPUT", "collect.daily received invalid arguments");
      return collectDaily(options, {
        workspaceId: context.workspaceId,
        ...(parsed.data.projectIds === undefined ? {} : { projectIds: parsed.data.projectIds }),
        ...(parsed.data.lookbackDays === undefined ? {} : { lookbackDays: parsed.data.lookbackDays }),
      });
    },
  });
}
