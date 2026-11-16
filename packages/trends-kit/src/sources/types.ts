import type { SourceResponse } from "@tavi/domain-kit";

import type { Bucket, CountPoint, RawItem, TrendEntry, TrendsSourceRecord } from "../contracts.js";
import type { HealthClass } from "../store/store.js";

export type { SourceResponse };

/**
 * A source as a pure adapter: it says which requests to make and
 * reads their answers; the plugin's worker makes them, through each source's
 * budget and health. A new source is one adapter and one record, replayed in
 * tests from recorded answers.
 */
export interface SourceRequest {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  /** A POST's body, already serialised. */
  readonly body?: string;
  /** How the worker reads the answer: `json`, the body parsed, or its text when it is not JSON (a source's plain-text errors, GDELT's plea to slow down); `text`, the text itself. */
  readonly expect: "json" | "text";
  /** `manual`: the worker follows a redirect itself, checking each hop (an open page's robots.txt); `follow` by default. */
  readonly redirect?: "follow" | "manual";
  /** What the request is for, carried to its parse (a feed's outlet, a project's article). */
  readonly tag?: string;
}

/** What one answer came to. A failure names the health class `sources` shows. */
export type ReadOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "rate-limited"; readonly retryAfterMs: number }
  | { readonly kind: "failed"; readonly class: Exclude<HealthClass, "ok">; readonly status: number; readonly detail?: string };

/** A topic as an adapter reads it: its terms flattened and by language, never a person. */
export interface AdapterTopic {
  readonly label: string;
  /** Every term once, in the topic's languages. */
  readonly terms: readonly string[];
  readonly termsByLanguage: Readonly<Record<string, readonly string[]>>;
  readonly exclude: readonly string[];
  readonly articles: Readonly<Record<string, string>>;
  readonly countries: readonly string[];
}

/** A window of whole buckets, `from` inclusive and `to` exclusive. */
export interface Window {
  readonly from: string;
  readonly to: string;
  readonly bucket: Bucket;
}

/** What one call of an adapter knows besides its input. */
export interface SourceCall {
  readonly now: string;
  /** A credential setting's value, or `undefined` when it is not set. */
  readonly credential: (key: string) => string | undefined;
  /** Plain settings the source reads (`mastodonInstances`, `pttBoard`). */
  readonly settings: Readonly<Record<string, unknown>>;
  /** An `oauth-client` source's access token, from its `authorize`. */
  readonly token?: string;
}

/** An access token, and how long it holds. */
export interface AccessToken {
  readonly token: string;
  readonly expiresInMs: number;
}

/** One series an answer holds: a metric and its buckets. */
export interface CountSeries {
  readonly metric: string;
  readonly points: readonly CountPoint[];
}

/** One operation of an adapter: the requests it makes, and how it reads each answer. */
export interface Operation<Input, Value> {
  request(input: Input, call: SourceCall): readonly SourceRequest[];
  parse(response: SourceResponse, request: SourceRequest, input: Input, call: SourceCall): ReadOutcome<Value>;
}

export interface TrendsAdapter {
  readonly record: TrendsSourceRecord;
  /** A topic's counts over a window, by metric. */
  readonly counts?: Operation<{ readonly topic: AdapterTopic; readonly window: Window }, readonly CountSeries[]>;
  /** A dated sample of items about a topic, or about a free query. */
  readonly sample?: Operation<{ readonly topic: AdapterTopic; readonly window: Window; readonly limit: number }, readonly RawItem[]>;
  /** What is trending now in a country. */
  readonly trending?: Operation<{ readonly country: string }, readonly TrendEntry[]>;
  /** An `oauth-client` source's token exchange: the worker runs it first and passes the token in `SourceCall.token`. */
  readonly authorize?: Operation<Record<string, never>, AccessToken>;
  /** An open page, not an API: the worker reads the host's robots.txt (and its Content-Signal) before each request, and a refusal stops it for the day. */
  readonly robots?: boolean;
  /** Why the source cannot be read with these settings, before any request (Yandex without its folder id). */
  readonly unconfigured?: (call: SourceCall) => string | undefined;
}
