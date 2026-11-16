import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWorkerFetcher, workerHome } from "@tavi/domain-kit";
import type { ExternalPluginContext, PluginToolCallContext } from "@tavi/plugin-types";
import {
  BRIEF_BULLETS_MAX,
  BULLET_CHARS_MAX,
  ListSpecSchema,
  TR1_ADAPTERS,
  TR2_ADAPTERS,
  TR3_RECORDS,
  TRENDS_SOURCE_KINDS,
  listAdapter,
  type BriefBullet,
  type TopicScope,
  type TrendsAdapter,
} from "@tavi/trends-kit";

import {
  INGEST_ROWS_MAX,
  createEngine,
  type CallContext,
  type Engine,
  type ExcludedSource,
  type Fetcher,
  type IngestRow,
  type SiteProfileLike,
  type WatchInput,
} from "./engine.js";

/**
 * `trends.radar` (docs/TRENDS.md): a confined
 * worker that reads free public trend sources for the topics a person tracks,
 * tests their velocity in code, and raises spikes on the heartbeat. Its
 * stores are `trends.db` and `cache/items.db` in its home. It never posts,
 * and never watches a person.
 */

const VERSION = "0.1.0";
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * One request with the worker's `fetch`, through its proxy, read to a bounded
 * body; JSON parsed when asked and it is JSON, else its text (a source's
 * plain-text error, GDELT's plea to slow down).
 */
export const workerFetcher: Fetcher = createWorkerFetcher({
  timeoutMs: REQUEST_TIMEOUT_MS,
  init: (request) => ({
    method: request.method ?? "GET",
    redirect: request.redirect ?? "follow",
    headers: {
      Accept: request.expect === "json" ? "application/json" : "application/rss+xml, application/xml, text/xml, text/plain",
      ...request.headers,
    },
    ...(request.body === undefined ? {} : { body: request.body }),
  }),
  read: (request) => request.expect,
  keep: { contentSignal: "content-signal", location: "location" },
});

/** A file shipped beside the bundle (`dist-plugin/`), or, in the workspace, the package's own. */
function shipped(...path: string[]): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const beside = join(here, ...path);
  return existsSync(beside) ? beside : join(here, "..", ...path);
}

/** The sources with no record, and why. */
function loadExcluded(): ExcludedSource[] {
  const file = JSON.parse(readFileSync(shipped("excluded.json"), "utf8")) as { readonly excluded: readonly ExcludedSource[] };
  return [...file.excluded];
}

/** Each country's source order (`routing/<CC>.json`). */
function loadRouting(): Record<string, readonly string[]> {
  const directory = shipped("routing");
  return Object.fromEntries(
    readdirSync(directory)
      .filter((file) => /^[A-Z]{2}\.json$/.test(file))
      .map((file) => {
        const route = JSON.parse(readFileSync(join(directory, file), "utf8")) as {
          readonly country: string;
          readonly order: readonly string[];
        };
        return [route.country, route.order];
      }),
  );
}

/** The open-page lists (`lists/<id>.json`), each paired with its record; a spec with no record is refused. */
function loadLists(): TrendsAdapter[] {
  const directory = shipped("lists");
  const records = new Map(TR3_RECORDS.map((record) => [record.id, record]));
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const spec = ListSpecSchema.parse(JSON.parse(readFileSync(join(directory, file), "utf8")));
      const record = records.get(spec.recordId);
      if (record === undefined || `${record.id}.json` !== file) throw new Error(`lists/${file} names no list record`);
      return listAdapter(record, spec);
    });
}

/** The browser site profiles the manifest names (`sites`), as shipped. */
function loadSites(): SiteProfileLike[] {
  const manifest = JSON.parse(readFileSync(shipped("tavi-plugin.json"), "utf8")) as { readonly sites?: readonly string[] };
  return (manifest.sites ?? []).map((path) => JSON.parse(readFileSync(shipped(path), "utf8")) as SiteProfileLike);
}

/** The engine, once a tool needs it; `stop` closes its stores. */
let engine: Engine | undefined;

/** Who a call is for: the operator's own when the owner names nobody. */
const callOf = (context: PluginToolCallContext | undefined): CallContext => ({
  scope: { principalId: context?.principalId ?? "operator", workspaceId: context?.workspaceId ?? "default" },
  unattended: context?.unattended === true,
});

/**
 * The tools' input schemas are written with the host's Zod (`ctx.z`), which
 * the worker turns into JSON Schema; their bounds are trends-kit's, which
 * checks a topic again (`TopicInputSchema`).
 */
export function register(ctx: ExternalPluginContext): void {
  const { z } = ctx;
  /** A credential setting's value; the host refuses one that holds nothing (`NOT_AUTHORIZED`), which is a key not set. */
  const keyOf = async (key: string): Promise<string | null> => {
    try {
      return await ctx.secret(key);
    } catch (error) {
      if ((error as { readonly code?: unknown }).code === "NOT_AUTHORIZED") return null;
      throw error;
    }
  };
  const use = (): Engine => {
    engine ??= createEngine({
      home: workerHome("trends.radar", "its stores"),
      fetcher: workerFetcher,
      config: ctx.config,
      credential: keyOf,
      version: VERSION,
      routing: loadRouting(),
      excluded: loadExcluded(),
      lists: loadLists(),
      sites: loadSites(),
    });
    return engine;
  };
  const country = z.string().regex(/^[A-Z]{2}$/);
  const sourceIds = [
    ...new Set([...TR1_ADAPTERS, ...TR2_ADAPTERS].map((adapter) => adapter.record.id).concat(TR3_RECORDS.map((record) => record.id))),
  ] as [string, ...string[]];
  const topicId = z.string().min(1).max(40);
  const window = z.enum(["24h", "7d", "30d"]);

  ctx.registerTool({
    name: "sources",
    inputSchema: z.object({ country: country.optional(), kind: z.enum(TRENDS_SOURCE_KINDS).optional() }),
    handler: (input) => use().sources(input as { country?: string; kind?: (typeof TRENDS_SOURCE_KINDS)[number] }),
  });
  ctx.registerTool({ name: "topics", inputSchema: z.object({}), handler: (_input, _options, context) => use().topics(callOf(context)) });
  // One object per op, each refusing a field it does not take.
  const topic = z
    .object({})
    .passthrough()
    .describe(
      "{label, terms: {en: ['solid-state battery']}, exclude?, wikidata?, articles?: {'en.wikipedia': 'Solid-state_battery'}, countries?, sources?, alert?: {growth, corroboration}}. A subject, never a person.",
    );
  const byId = <Op extends "pause" | "resume" | "remove">(op: Op) => z.strictObject({ op: z.literal(op), topicId });
  ctx.registerTool({
    name: "watch",
    inputSchema: z.discriminatedUnion("op", [
      z.strictObject({ op: z.literal("add"), topic }),
      z.strictObject({ op: z.literal("update").describe("replace the topic's definition"), topicId, topic }),
      byId("pause"),
      byId("resume"),
      byId("remove"),
    ]),
    handler: (input, _options, context) => use().watch(input as WatchInput, callOf(context)),
  });
  ctx.registerTool({
    name: "sweep",
    inputSchema: z.object({ topicIds: z.array(topicId).min(1).max(10).optional() }),
    handler: (input, { signal }, context) => use().sweep(input as { topicIds?: string[] }, signal, callOf(context)),
  });
  ctx.registerTool({
    name: "velocity",
    inputSchema: z.object({ topicId, window: window.default("7d"), bucket: z.enum(["hour", "day"]).optional() }),
    handler: (input, _options, context) =>
      use().velocity(input as { topicId: string; window: "24h" | "7d" | "30d"; bucket?: "hour" | "day" }, callOf(context)),
  });
  ctx.registerTool({
    name: "compare",
    inputSchema: z.object({ topicIds: z.array(topicId).min(1).max(5), window: window.default("30d") }),
    handler: (input, _options, context) => use().compare(input as { topicIds: string[]; window: "24h" | "7d" | "30d" }, callOf(context)),
  });
  ctx.registerTool({
    name: "snapshot",
    inputSchema: z.object({ country, sources: z.array(z.enum(sourceIds)).max(16).optional() }),
    handler: (input, { signal }, context) => use().snapshot(input as { country: string; sources?: string[] }, signal, callOf(context)),
  });
  ctx.registerTool({
    name: "search",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(200).describe("A subject's words: never a person's handle"),
      languages: z
        .array(z.string().regex(/^[a-z]{2,3}$/))
        .min(1)
        .max(8)
        .optional(),
      countries: z.array(country).max(10).optional(),
      window: window.default("7d"),
      sources: z.array(z.enum(sourceIds)).max(16).optional(),
    }),
    handler: (input, { signal }, context) =>
      use().search(
        input as { query: string; languages?: string[]; countries?: string[]; window: "24h" | "7d" | "30d"; sources?: string[] },
        signal,
        callOf(context),
      ),
  });
  ctx.registerTool({
    name: "brief",
    inputSchema: z.object({
      topicId,
      bullets: z
        .array(
          z.object({
            text: z.string().max(BULLET_CHARS_MAX * 2),
            cites: z.array(z.string().min(1).max(80)).max(10),
            quotes: z
              .array(
                z.object({
                  itemId: z.string().min(1).max(80),
                  span: z.string().max(BULLET_CHARS_MAX),
                  translated: z.boolean().optional(),
                  original: z
                    .string()
                    .max(BULLET_CHARS_MAX * 2)
                    .optional(),
                }),
              )
              .max(5)
              .optional(),
            corroborated: z.boolean().optional(),
          }),
        )
        .max(BRIEF_BULLETS_MAX * 2),
    }),
    handler: (input, _options, context) => use().brief(input as { topicId: string; bullets: BriefBullet[] }, callOf(context)),
  });
  ctx.registerTool({
    name: "cluster",
    inputSchema: z
      .object({
        topicId: topicId.optional(),
        itemSet: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
          .optional(),
        minClusterSize: z.number().int().min(1).max(500).optional(),
      })
      .refine((input) => (input.topicId === undefined) !== (input.itemSet === undefined), "give a topicId or an itemSet"),
    handler: (input, _options, context) =>
      use().cluster(input as { topicId?: string; itemSet?: string; minClusterSize?: number }, callOf(context)),
  });
  ctx.registerTool({
    name: "profile",
    inputSchema: z.object({ profileId: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/) }),
    handler: (input) => use().profile(input as { profileId: string }),
  });
  ctx.registerTool({
    name: "ingest",
    inputSchema: z.object({
      profileId: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,39}$/)
        .describe("The site profile the rows were read under: each row's link is on its hosts"),
      itemSet: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
        .describe("A name for what was read together: daum-realtime-2026-10-17"),
      items: z
        .array(
          z.object({
            url: z.string().url().max(2_048),
            title: z.string().min(1).max(300),
            text: z.string().max(2_048).optional(),
            rank: z.number().int().min(1).max(1_000).optional(),
            metric: z.number().min(0).optional(),
          }),
        )
        .min(1)
        .max(INGEST_ROWS_MAX),
    }),
    handler: (input, _options, context) =>
      use().ingest(input as { profileId: string; itemSet: string; items: IngestRow[] }, callOf(context)),
  });
  // The heartbeat's spikes source: the person's raised topics, and the next sweep started.
  ctx.provideSignals?.({
    id: "spikes",
    retracts: false,
    collect: async ({ workspaceId, principalId, now }) =>
      use().signals({ workspaceId, principalId, now } satisfies TopicScope & { now: string }),
  });
}

export function stop(): void {
  engine?.close();
  engine = undefined;
}
