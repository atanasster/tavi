import type { SourceResponse } from "@tavi/domain-kit";

import type { JobQuery, JobSourceRecord } from "../contracts.js";
import type { RawPosting } from "../normalize.js";

export type { SourceResponse };

/**
 * A source of postings as a pure adapter: it says which requests to
 * make and reads their answers, and the plugin's worker makes them. A new
 * board is one adapter and one record, replayed in tests from recordings.
 */
export interface SourceRequest {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** How the worker reads the body: parsed JSON, or the text itself. */
  readonly body: "json" | "text";
  /** A search's list, or one posting's detail (Greenhouse's pay, SmartRecruiters' description). */
  readonly purpose: "search" | "detail";
  /** The board the request reads, for a per-tenant source. */
  readonly tenant?: string;
  /** The query's keywords, carried to the requests a first one leads to (Workday's sitemap, then its pages). */
  readonly keywords?: readonly string[];
  /**
   * A tool call on an official board MCP server at `url`: the worker
   * runs the exchange (`mcpToolCall`) and the adapter reads its `McpBody`.
   */
  readonly mcp?: { readonly tool: string; readonly arguments: Readonly<Record<string, unknown>> };
}

export type SourceOutcome =
  /** `dropped`: records that did not have the shape the adapter reads; many of them is drift. */
  /** `removed`: the refs of postings the source says are gone (NAV's `INACTIVE`, JobTech's `removed`), hidden at once. */
  /** `cursor`: where the source's next read starts (NAV's feed), kept by the engine and given back in `SourceCall.cursor`. */
  /** `more`: further requests this answer leads to (Workday's sitemap, then its job pages), read after `next`. */
  | {
      readonly kind: "ok";
      readonly postings: readonly RawPosting[];
      readonly dropped: number;
      readonly next?: SourceRequest;
      readonly removed?: readonly string[];
      readonly cursor?: string;
      readonly more?: readonly SourceRequest[];
    }
  /** The site's robots.txt disallows what the adapter would read. */
  | { readonly kind: "disallowed"; readonly why: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "rate-limited"; readonly retryAfterMs: number }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "failed"; readonly status: number }
  /** The answer is not the shape this adapter reads: the source changed. */
  | { readonly kind: "drift"; readonly detail: string };

export interface SourceCall {
  /** The person's credential settings this source names, by config key; absent when not set. */
  readonly credential: (key: string) => string | undefined;
  /** `Tavi-jobs/<version> (+<contact>)`. */
  readonly userAgent: string;
  /** The operator's contact address, for a source that requires one (USAJOBS' `User-Agent`). */
  readonly contact?: string | undefined;
  /** Where this source's last read ended, when it reads a feed forward. */
  readonly cursor?: string | undefined;
  readonly now: string;
}

export interface JobSourceAdapter {
  readonly record: JobSourceRecord;
  /** The most requests one search makes of it, when more than a few pages (Workday's robots, sitemap and pages). */
  readonly requestsPerSearch?: number;
  /** The requests a search makes; none when the source cannot serve it (no board named, no key, no country it covers). */
  search(query: JobQuery, call: SourceCall, tenant?: string): readonly SourceRequest[];
  /** One posting by the ref its search gave it. */
  detail?(ref: string, call: SourceCall): SourceRequest | undefined;
  /** The `detail` ref of a posting's own page on this source, for `get` by URL; `undefined` for any other URL. */
  refFromUrl?(url: string): string | undefined;
  parse(response: SourceResponse, request: SourceRequest, call: SourceCall): SourceOutcome;
}
