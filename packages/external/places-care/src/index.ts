import { join } from "node:path";

import { createWorkerFetcher, workerHome } from "@tavi/domain-kit";
import { providersInput, registryCheckInput } from "@tavi/places-kit";
import type { ExternalPluginContext } from "@tavi/plugin-types";

import { createCareEngine, type CareEngine, type Fetcher } from "./engine.js";
import { PAYERS } from "./payers.js";

/**
 * `places.care`: a confined
 * worker, Personal, that finds health providers in public registries and
 * checks them against a payer's published network. It keeps nothing about a
 * provider, a plan or the person; `care.db` holds only budgets, health and
 * the request log.
 */

const VERSION = "0.1.1";
const REQUEST_TIMEOUT_MS = 25_000;

/** One request with the worker's `fetch`, through its proxy, read to a bounded body: JSON, whatever the request says. */
export const workerFetcher: Fetcher = createWorkerFetcher({
  timeoutMs: REQUEST_TIMEOUT_MS,
  init: (request) => ({ headers: { Accept: "application/json", ...request.headers } }),
  read: () => "json",
});

let engine: CareEngine | undefined;

export function register(ctx: ExternalPluginContext): void {
  const { z } = ctx;
  const use = (): CareEngine => {
    engine ??= createCareEngine({
      storePath: join(workerHome("places.care"), "care.db"),
      fetcher: workerFetcher,
      config: ctx.config,
      version: VERSION,
    });
    return engine;
  };
  const unattended = (context: { readonly unattended?: boolean } | undefined) => ({ unattended: context?.unattended === true });
  const npi = z.string().regex(/^\d{10}$/);
  // The host's Zod draws the input schemas the model sees (open); places-kit checks each input again (strict).
  ctx.registerTool({
    name: "providers",
    inputSchema: providersInput(z, "open"),
    handler: (input, { signal }, context) => use().providers(input, signal, unattended(context)),
  });
  ctx.registerTool({
    name: "registry_check",
    inputSchema: registryCheckInput(z, "open"),
    handler: (input, { signal }, context) => use().registryCheck(input, signal, unattended(context)),
  });
  ctx.registerTool({
    name: "in_network",
    inputSchema: z.object({
      payer: z.enum(PAYERS.map((payer) => payer.id) as [string, ...string[]]).describe("The insurer"),
      plan: z.string().min(2).max(120).describe("The plan or network name as printed on the card; never the member id"),
      providers: z.array(npi).min(1).max(20).describe("NPIs, from providers or registry_check"),
      state: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .optional()
        .describe("The two-letter US state the providers practise in (the ZIP code's), so another state's network is not counted"),
    }),
    handler: (input, { signal }, context) => use().inNetwork(input, signal, unattended(context)),
  });
  ctx.registerTool({ name: "sources", inputSchema: z.object({}), handler: () => use().sources() });
}

export function stop(): void {
  engine?.close();
  engine = undefined;
}
