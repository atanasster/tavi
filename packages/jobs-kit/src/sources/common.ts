import { decodeEntities } from "@tavi/contracts";
import { retryAfterMs } from "@tavi/domain-kit";
import { z } from "zod";

import type { McpBody } from "../mcp-client.js";
import type { RawPosting } from "../normalize.js";
import type { SourceOutcome, SourceResponse } from "./types.js";

/** The outcome of an answer that is not a 200, or `undefined` for a 200 the adapter reads. */
export function statusOutcome(response: SourceResponse, now: string): SourceOutcome | undefined {
  if (response.status === 200) return undefined;
  if (response.status === 404 || response.status === 410) return { kind: "not-found" };
  if (response.status === 429) return { kind: "rate-limited", retryAfterMs: retryAfterMs(response.retryAfter, now) };
  if (response.status === 401 || response.status === 403) return { kind: "unauthorized" };
  return { kind: "failed", status: response.status };
}

/**
 * An MCP tool call's answer: the tool's value, or its outcome. A
 * tool the server no longer has, or whose arguments it no longer takes, is
 * drift; a tool that failed, or a server that refused to start a session, is
 * a failure. The server's own error text is not kept: it is third-party text.
 */
export function mcpValue(response: SourceResponse, now: string): { readonly value: unknown } | SourceOutcome {
  const status = statusOutcome(response, now);
  if (status !== undefined) return status;
  const body = response.body as McpBody | null;
  if (body === null || typeof body !== "object") return { kind: "drift", detail: "the server's answer is not MCP" };
  if (body.kind === "error")
    return body.step === "call" && (body.code === -32601 || body.code === -32602)
      ? { kind: "drift", detail: `the server no longer takes this tool call (JSON-RPC ${String(body.code)})` }
      : { kind: "failed", status: 502 };
  if (body.isError) return { kind: "failed", status: 502 };
  return { value: body.value };
}

/**
 * Each record of a list read by `read`, which throws (or returns undefined)
 * for one it cannot; those are counted as dropped. A list that is not one at
 * all, or of which more than half is dropped, is drift.
 */
export function readList(items: unknown, read: (item: unknown) => RawPosting | undefined, what: string): SourceOutcome {
  if (!Array.isArray(items)) return { kind: "drift", detail: `${what} is not a list` };
  const postings: RawPosting[] = [];
  let dropped = 0;
  for (const item of items) {
    let posting: RawPosting | undefined;
    try {
      posting = read(item);
    } catch {
      posting = undefined;
    }
    if (posting === undefined) dropped += 1;
    else postings.push(posting);
  }
  if (items.length > 0 && dropped * 2 > items.length)
    return { kind: "drift", detail: `${String(dropped)} of ${String(items.length)} ${what} did not have the expected shape` };
  return { kind: "ok", postings, dropped };
}

/** A board name as it may appear in a path or a host: letters, digits, `-`, `_`, `.`. */
export function tenantOf(tenant: string | undefined): string | undefined {
  return tenant !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tenant) && !tenant.includes("..") ? tenant : undefined;
}

/** A tenant with an optional region prefix: `eu:acme` → `{ region: "eu", name: "acme" }`. */
export function regionalTenant(
  tenant: string | undefined,
  regions: readonly string[],
): { readonly region?: string; readonly name: string } | undefined {
  if (tenant === undefined) return undefined;
  const colon = tenant.indexOf(":");
  const region = colon === -1 ? undefined : tenant.slice(0, colon).toLowerCase();
  const name = tenantOf(colon === -1 ? tenant : tenant.slice(colon + 1));
  if (name === undefined || (region !== undefined && !regions.includes(region))) return undefined;
  return { ...(region === undefined ? {} : { region }), name };
}

/** Text that may hold HTML-escaped markup (Greenhouse's `content`). */
export const unescapeHtml = (text: string): string => decodeEntities(text);

/** Words a query's keywords join into for a source's own search box. */
export const keywordsText = (keywords: readonly string[]): string => keywords.join(" ").slice(0, 200);

/** A source's time with no zone, read as UTC: a day's error at most. */
export const utcTime = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;

/** A place name a source writes in capitals ("OSLO", "NEUFCHÂTEAU") as a reader writes it. */
export const titleCase = (name: string): string =>
  name
    .toLowerCase()
    .replace(/(^|[\s-])\p{L}/gu, (letter) => letter.toUpperCase())
    .slice(0, 80);

export const optionalString = z
  .string()
  .nullish()
  .transform((value) => (value === null || value === undefined || value.trim() === "" ? undefined : value));
