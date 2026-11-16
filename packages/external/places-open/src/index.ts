import { join } from "node:path";

import { createWorkerFetcher, workerHome } from "@tavi/domain-kit";
import {
  areaReportInput,
  availabilityInput,
  bookingStatusInput,
  evChargersInput,
  fuelPricesInput,
  fuelWatchInput,
  placesQueryInput,
  routeStopsInput,
  verifyLicenseInput,
} from "@tavi/places-kit";
import type { ExternalPluginContext } from "@tavi/plugin-types";
import { asyncBufferFromUrl } from "hyparquet";

import { createEngine, type Engine, type Fetcher } from "./engine.js";
import { LICENSING } from "./licensing.js";

/** The professions the licensing matrix has a row for, as the model is told them. */
const PROFESSIONS = [...new Set(LICENSING.flatMap((file) => file.rows.map((row) => row.profession)))].sort();

/**
 * `places.open`: a confined worker
 * that finds places from open data, resolves them across sources, and keeps
 * them in `places.db` in its home as each source's terms allow. It never
 * books, types into a page, or sends anything.
 */

const VERSION = "0.1.0";
const REQUEST_TIMEOUT_MS = 25_000;
/** A file read line by line (Germany's charging register, about 55 MB a month): its own limits. */
const STREAM_MAX_BYTES = 200 * 1024 * 1024;
const STREAM_TIMEOUT_MS = 10 * 60_000;
/** The longest one line may grow before it ends: a file without line breaks is refused, not held. */
const STREAM_LINE_MAX = 1024 * 1024;

/** One request with the worker's `fetch`, through its proxy, read to a bounded body. */
export const workerFetcher: Fetcher = createWorkerFetcher({
  timeoutMs: REQUEST_TIMEOUT_MS,
  init: (request) => ({
    ...(request.method === undefined ? {} : { method: request.method, body: request.payload }),
    headers: { Accept: request.body === "json" ? "application/json" : request.body === "bytes" ? "*/*" : "text/plain", ...request.headers },
  }),
  read: (request) => request.body,
});

/** A remote text file's lines as they arrive, through the worker's proxy, never the whole file in memory. */
export async function* workerLines(url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal): AsyncGenerator<string> {
  const response = await fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(STREAM_TIMEOUT_MS)]) });
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    throw new Error(`HTTP ${String(response.status)}`);
  }
  const decoder = new TextDecoder("utf-8");
  let rest = "";
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > STREAM_MAX_BYTES) throw new Error(`the file is over ${String(STREAM_MAX_BYTES)} bytes`);
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    if (rest.length > STREAM_LINE_MAX) throw new Error(`a line is over ${String(STREAM_LINE_MAX)} characters`);
    yield* lines;
  }
  rest += decoder.decode();
  if (rest !== "") yield rest;
}

let engine: Engine | undefined;
/** Due watches run on their own clock too, not only when a heartbeat collects: the plugin checks every quarter hour. */
const SWEEP_EVERY_MS = 15 * 60_000;
let sweeper: ReturnType<typeof setInterval> | undefined;

export function register(ctx: ExternalPluginContext): void {
  const { z } = ctx;
  const use = (): Engine => {
    engine ??= createEngine({
      storePath: join(workerHome("places.open"), "places.db"),
      fetcher: workerFetcher,
      openParquet: (url) => asyncBufferFromUrl({ url }),
      openLines: workerLines,
      credential: (key) => ctx.secret(key),
      config: ctx.config,
      version: VERSION,
    });
    return engine;
  };
  const unattended = (context: { readonly unattended?: boolean } | undefined) => ({ unattended: context?.unattended === true });
  // The host's Zod draws the input schemas the model sees (open); places-kit checks each input again (strict).
  ctx.registerTool({
    name: "search",
    inputSchema: placesQueryInput(z, "open"),
    handler: (input, { signal }, context) => use().search(input, signal, unattended(context)),
  });
  ctx.registerTool({
    name: "details",
    inputSchema: z.object({ placeId: z.string().regex(/^pl_[0-9a-f]{16}$/) }),
    handler: (input, { signal }, context) => use().details(input as { placeId: string }, signal, unattended(context)),
  });
  ctx.registerTool({
    name: "reconcile",
    inputSchema: z.object({
      items: z
        .array(z.object({ kind: z.enum(["jsonld", "record"]) }).passthrough())
        .min(1)
        .max(20)
        .describe(
          "What the agent read: {kind: jsonld, url, data} (a LocalBusiness from browser.structured) | {kind: record, url, name, lat, lon, address, phone, hours}",
        ),
      placeIds: z
        .array(z.string().regex(/^pl_[0-9a-f]{16}$/))
        .max(10)
        .optional(),
      openAt: z.string().datetime({ offset: true }).optional(),
    }),
    handler: (input) => use().reconcile(input as { items: unknown[]; placeIds?: string[]; openAt?: string }),
  });
  ctx.registerTool({
    name: "availability",
    inputSchema: availabilityInput(z, "open"),
    handler: (input) => use().availability(input),
  });
  ctx.registerTool({
    name: "booking_status",
    inputSchema: bookingStatusInput(z, "open"),
    handler: (input) => use().bookingStatus(input),
  });
  ctx.registerTool({
    name: "compare",
    inputSchema: z.object({
      placeIds: z
        .array(z.string().regex(/^pl_[0-9a-f]{16}$/))
        .min(1)
        .max(10),
    }),
    handler: (input) => use().compare(input as { placeIds: string[] }),
  });
  ctx.registerTool({
    name: "route_stops",
    inputSchema: routeStopsInput(z, "open"),
    handler: (input, { signal }, context) => use().routeStops(input, signal, unattended(context)),
  });
  ctx.registerTool({
    name: "area_report",
    inputSchema: areaReportInput(z, "open"),
    handler: (input, { signal }, context) => use().areaReport(input, signal, unattended(context)),
  });
  ctx.registerTool({
    name: "ev_chargers",
    inputSchema: evChargersInput(z, "open"),
    handler: (input, { signal }, context) => use().evChargers(input, signal, unattended(context)),
  });
  ctx.registerTool({
    name: "fuel_prices",
    inputSchema: fuelPricesInput(z, "open"),
    handler: (input, { signal }, context) => use().fuelPrices(input, signal, unattended(context)),
  });
  ctx.registerTool({
    name: "verify_license",
    inputSchema: verifyLicenseInput(z, "open", `One of the matrix's professions: ${PROFESSIONS.join(", ")}`),
    handler: (input, { signal }, context) => use().verifyLicense(input, signal, unattended(context)),
  });
  ctx.registerTool({
    name: "watch",
    inputSchema: fuelWatchInput(z, "open"),
    handler: (input, { signal }, context) => use().watch(input, signal, unattended(context)),
  });
  ctx.registerTool({
    name: "digest",
    inputSchema: z.object({
      watchId: z
        .string()
        .regex(/^fw_[0-9a-f]{12}$/)
        .optional(),
      since: z.string().datetime({ offset: true }).optional(),
    }),
    handler: (input) => use().digest(input as { watchId?: string; since?: string }),
  });
  ctx.registerTool({ name: "sources", inputSchema: z.object({}), handler: () => use().sources() });
  // The fuel watches' heartbeat source: hits, model-free.
  ctx.provideSignals?.({ id: "watches", retracts: false, collect: async () => use().signals() });
  // A worker that cannot open its store (beside the owner) has nothing to sweep: the failure is that store's, not a watch's.
  sweeper ??= setInterval(() => {
    try {
      // Best effort: a sweep that fails leaves expired entries for the next one.
      void use()
        .sweep()
        .catch(() => undefined);
    } catch {
      // No store here: nothing to sweep.
    }
  }, SWEEP_EVERY_MS);
  sweeper.unref();
}

export function stop(): void {
  if (sweeper !== undefined) clearInterval(sweeper);
  sweeper = undefined;
  engine?.close();
  engine = undefined;
}
