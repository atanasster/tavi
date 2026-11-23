import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boundedText, createWorkerFetcher, workerHome } from "@tavi/domain-kit";
import type { ExternalPluginContext } from "@tavi/plugin-types";
import {
  J1_SOURCES,
  J2_SOURCES,
  JOB_APPLICATION_STATES,
  jobProfileInput,
  mcpToolCall,
  observedFieldInput,
  personAnswerInput,
  type McpPost,
  type SkillDictionary,
} from "@tavi/jobs-kit";

import { createEngine, type Engine, type Fetcher, type WatchInput } from "./engine.js";

/**
 * `jobs.finder` (docs/JOBS.md): a confined worker
 * that searches job sources, matches postings to a profile in code, and keeps
 * the person's pipeline in `jobs.db` in its home. It never types into a page,
 * applies, or sends anything.
 */

const VERSION = "0.1.1";
const REQUEST_TIMEOUT_MS = 20_000;

const USER_AGENT = `Tavi-jobs/${VERSION}`;
const timed = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

/** One request with the worker's `fetch`, through its proxy, read to a bounded body. */
const fetchAnswer: Fetcher = createWorkerFetcher({
  timeoutMs: REQUEST_TIMEOUT_MS,
  init: (request) => ({
    headers: {
      "User-Agent": USER_AGENT,
      Accept: request.body === "json" ? "application/json" : "application/xml, text/xml, text/plain",
      ...request.headers,
    },
  }),
  read: (request) => request.body,
  keep: { etag: "etag" },
});

/** One request with the worker's `fetch`; an MCP tool call as its whole exchange. */
export const workerFetcher: Fetcher = async (request, signal) => {
  const { mcp } = request;
  if (mcp !== undefined) {
    const post: McpPost = async (body, headers, inner) => {
      const response = await fetch(request.url, {
        method: body === undefined ? "DELETE" : "POST",
        headers: { "User-Agent": USER_AGENT, ...request.headers, ...headers },
        ...(body === undefined ? {} : { body }),
        signal: timed(inner),
      });
      const { text } = await boundedText(response);
      return {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        session: response.headers.get("mcp-session-id"),
        text,
      };
    };
    return mcpToolCall(post, mcp.tool, mcp.arguments, { name: "tavi-jobs", version: VERSION }, signal);
  }
  return fetchAnswer(request, signal);
};

/**
 * The skills dictionary: `assets/skills.json` beside the bundle, kept
 * out of it under its own budget; run from `src/` (the tests), the
 * package's own copy (`scripts/dictionary.mjs`, vitest's global setup).
 */
function loadDictionary(): SkillDictionary {
  const here = dirname(fileURLToPath(import.meta.url));
  const shipped = join(here, "assets", "skills.json");
  const path = existsSync(shipped) ? shipped : join(here, "..", "assets", "skills.json");
  return JSON.parse(readFileSync(path, "utf8")) as SkillDictionary;
}

/** The boards a search can name: the per-employer sources. */
const BOARDS = [...J1_SOURCES, ...J2_SOURCES]
  .filter((source) => source.record.tenancy === "per-tenant")
  .map((source) => source.record.id) as [string, ...string[]];

/** The engine, once a tool needs it; `stop` closes its store. */
let engine: Engine | undefined;

/**
 * The tools' input schemas are written with the host's Zod (`ctx.z`), which
 * the worker turns into JSON Schema; their bounds and enums are jobs-kit's,
 * which checks each input again (`JobQuerySchema`, `JobProfileInputSchema`).
 */
export function register(ctx: ExternalPluginContext): void {
  const { z } = ctx;
  const use = (): Engine => {
    engine ??= createEngine({
      storePath: join(workerHome("jobs.finder"), "jobs.db"),
      dictionary: loadDictionary(),
      fetcher: workerFetcher,
      credential: (key) => ctx.secret(key),
      config: ctx.config,
      version: VERSION,
    });
    return engine;
  };
  const unattended = (context: { readonly unattended?: boolean } | undefined) => ({ unattended: context?.unattended === true });
  const states = z.enum(JOB_APPLICATION_STATES);

  const query = z.object({
    keywords: z.array(z.string().min(1).max(60)).max(10).describe("Job title or skill words: never the person's name or CV"),
    countries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .max(8)
      .default([])
      .describe("ISO country codes"),
    place: z.object({ city: z.string().max(80), radiusKm: z.number().int().min(0).max(300) }).optional(),
    workplace: z
      .array(z.enum(["remote", "hybrid", "onsite"]))
      .max(3)
      .optional(),
    postedWithinDays: z.number().int().min(1).max(60).default(14),
    employers: z
      .array(z.object({ source: z.enum(BOARDS), tenant: z.string().min(1).max(128) }))
      .max(50)
      .optional()
      .describe(
        "Employers' boards: Greenhouse 'acme', Lever 'acme' or 'eu:acme', Personio 'acme' or 'com:acme', Breezy 'acme', Workable 'acme', Workday '<company>.wd<N>/<site>' as in its careers URL (nvidia.wd5/NVIDIAExternalCareerSite)",
      ),
    sources: z.array(z.string().min(1).max(40)).max(16).optional(),
  });
  const profile = jobProfileInput(z, "open");
  ctx.registerTool({
    name: "search",
    inputSchema: query,
    handler: (input, { signal }, context) => use().search(input, signal, unattended(context)),
  });
  ctx.registerTool({
    name: "get",
    inputSchema: z
      .object({ postingId: z.string().min(1).max(80).optional(), url: z.string().url().max(2_048).optional() })
      .refine((input) => (input.postingId === undefined) !== (input.url === undefined), "give a postingId or a url"),
    handler: (input, { signal }) => use().get(input as { postingId?: string; url?: string }, signal),
  });
  ctx.registerTool({
    name: "match",
    inputSchema: z
      .object({
        postingIds: z.array(z.string().min(1).max(80)).min(1).max(200).optional(),
        watchId: z.string().min(1).max(40).optional().describe("Match a watch's hits instead of postingIds"),
        profile: profile.describe("From the person's reviewed memory, jobs.profile.*"),
      })
      .refine((input) => (input.postingIds === undefined) !== (input.watchId === undefined), "give postingIds or a watchId"),
    handler: (input) => use().match(input as { postingIds?: string[]; watchId?: string; profile: unknown }),
  });
  ctx.registerTool({
    name: "pipeline",
    inputSchema: z.object({ states: z.array(states).max(8).optional() }),
    handler: (input) => use().pipeline(input as { states?: (typeof JOB_APPLICATION_STATES)[number][] }),
  });
  ctx.registerTool({
    name: "track",
    inputSchema: z.object({ postingId: z.string().min(1).max(80), state: states, note: z.string().max(500).optional() }),
    handler: (input) => use().track(input as { postingId: string; state: (typeof JOB_APPLICATION_STATES)[number]; note?: string }),
  });
  ctx.registerTool({ name: "sources", inputSchema: z.object({}), handler: () => use().sources() });
  // One object per action, each refusing a field it does not take.
  const watchId = z.string().min(1).max(40);
  const watchFields = {
    name: z.string().min(1).max(80),
    query: query.describe("What to search for: as search takes it"),
    criteria: profile.describe("The profile to match against, snapshot from jobs.profile.*: sweeps run without memory"),
  };
  const watchSettings = {
    cadence: z.number().int().min(1).max(168).optional().describe("Hours between sweeps; 24 if not given"),
    minScore: z.number().min(0).max(1).optional(),
    digest: z
      .strictObject({
        at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        timezone: z.string().min(1).max(64),
        deliverTo: z.string().min(1).max(120),
      })
      .optional()
      .describe("A daily digest: the reply gives the schedule to create"),
  };
  const byId = <Action extends "pause" | "resume" | "remove">(action: Action) => z.strictObject({ action: z.literal(action), watchId });
  ctx.registerTool({
    name: "watch",
    inputSchema: z.discriminatedUnion("action", [
      z.strictObject({ action: z.literal("create"), ...watchFields, ...watchSettings }),
      z.strictObject({
        action: z.literal("update").describe("change what is given; the rest stays"),
        watchId,
        name: watchFields.name.optional(),
        query: watchFields.query.optional(),
        criteria: watchFields.criteria.optional(),
        ...watchSettings,
      }),
      byId("pause"),
      byId("resume"),
      byId("remove"),
    ]),
    handler: (input) => use().watch(input as WatchInput),
  });
  ctx.registerTool({
    name: "digest",
    inputSchema: z.object({
      watchId: z.string().min(1).max(40),
      since: z.string().datetime({ offset: true }).describe("Hits first seen after this time, such as 24 hours ago"),
    }),
    handler: (input) => use().digest(input as { watchId: string; since: string }),
  });
  ctx.registerTool({
    name: "ingest",
    inputSchema: z.object({
      items: z
        .array(z.object({ kind: z.enum(["jsonld", "record", "email", "links"]) }).passthrough())
        .min(1)
        .max(50)
        .describe(
          "What the agent gathered: {kind: jsonld, url, record} | {kind: record, url, title, company, location, description, salary, postedAt} | {kind: email, from, subject, body} | {kind: links, url, links}",
        ),
      personSaved: z
        .boolean()
        .optional()
        .describe("The person chose to save the one posting they opened on a site Tavi reads for the chat only"),
    }),
    handler: (input) => use().ingest(input as { items: unknown; personSaved?: boolean }),
  });
  ctx.registerTool({
    name: "fill_plan",
    inputSchema: z.object({
      fields: z.array(observedFieldInput(z, "open")).max(100).describe("The form's fields as browser.observe gave them"),
      facts: z
        .object({
          name: z.string().max(200).optional(),
          firstName: z.string().max(100).optional(),
          lastName: z.string().max(100).optional(),
          email: z.string().max(320).optional(),
          phone: z.string().max(60).optional(),
          location: z.string().max(200).optional(),
          links: z
            .array(z.object({ label: z.string().max(60), url: z.string().url().max(2_048) }))
            .max(10)
            .optional(),
          workHistory: z.array(z.string().max(500)).max(20).optional(),
          education: z.array(z.string().max(500)).max(10).optional(),
        })
        .optional()
        .describe("From the person's reviewed memory, jobs.profile.facts"),
      answers: z
        .array(personAnswerInput(z, "open"))
        .max(50)
        .optional()
        .describe("What the person answered in chat, to questions in their words"),
      postingId: z.string().min(1).max(80).optional(),
    }),
    handler: (input) => use().fillPlan(input as { fields: unknown; facts?: unknown; answers?: unknown; postingId?: string }),
  });
  ctx.registerTool({
    name: "tailor_check",
    inputSchema: z.object({
      text: z.string().min(1).max(20_000),
      postingId: z.string().min(1).max(80),
      profileSkills: z.array(z.string().max(80)).max(200).optional(),
    }),
    handler: (input) => use().tailorCheck(input as { text: string; postingId: string; profileSkills?: string[] }),
  });
  // The heartbeat's Jobs source: sweeps without a model, and their hits.
  ctx.provideSignals?.({ id: "watches", retracts: false, collect: async () => use().signals() });
}

export function stop(): void {
  engine?.close();
  engine = undefined;
}
