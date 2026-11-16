import { z } from "zod";

import type { AsyncRepository } from "./persistence-types.js";
import { hostOfUrl } from "./tool-result.js";

/**
 * A site profile: what Tavi may do on
 * a site a domain plugin names, in its `sites` block. Reviewed and hash-pinned
 * with the plugin, and off until the operator turns it on in Connected apps
 * ("Sites this app may browse"). The rules it sets are enforced in the browser
 * tools.
 */
export const SITE_PROFILE_ABI = "tavi.sites/1";
export const SITE_PROFILE_KINDS = [
  "directory",
  "reviews",
  "booking",
  "registry",
  "fuel",
  "health",
  "jobs-board",
  "ats",
  "trending",
] as const;
export const SITE_ACCESS_MODES = ["read", "assist-only", "stage", "none"] as const;

/** An exact host or `*.suffix`; never `*`. */
const SITE_HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** Second-level labels a country's registry sells under (`co.uk`, `com.au`): a wildcard over one names many owners. */
const PUBLIC_SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic"]);
/** Shared hosts whose subdomains are other people's sites. */
const SHARED_HOSTS = new Set([
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "blogspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "amazonaws.com",
  "wordpress.com",
  "wixsite.com",
]);

/**
 * Whether a `*.suffix` pattern covers many unrelated owners: a public suffix
 * (`*.co.uk`) or a shared host (`*.github.io`). A heuristic, not the public
 * suffix list: it refuses the common cases a profile could name by mistake.
 */
export function siteWildcardTooWide(pattern: string): boolean {
  if (!pattern.startsWith("*.")) return false;
  const labels = pattern.slice(2).split(".");
  if (labels.length < 2) return true;
  if (labels.length > 2) return false;
  const [first = "", tld = ""] = labels;
  return SHARED_HOSTS.has(labels.join(".")) || (tld.length === 2 && PUBLIC_SECOND_LEVEL.has(first));
}

const SiteProfileObjectSchema = z.strictObject({
  abi: z.literal(SITE_PROFILE_ABI),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  name: z.string().max(80),
  countries: z
    .array(z.string().regex(/^([A-Z]{2}|\*)$/))
    .min(1)
    .max(30),
  hosts: z.array(z.string().max(253).regex(SITE_HOST, "a host is exact or *.suffix, never *")).min(1).max(8),
  kind: z.enum(SITE_PROFILE_KINDS),
  access: z.strictObject({
    mode: z.enum(SITE_ACCESS_MODES),
    /** `false`: Tavi never navigates there; it reads only a page the person brought up. */
    navigate: z.boolean().default(true),
    /** Unattended reads allowed (sweeps, heartbeat watch lines); never with `stage`. */
    watchable: z.boolean().default(false),
    robots: z.literal("respect").default("respect"),
    reason: z.string().max(300),
    termsUrl: z.string().url(),
    reviewedAt: z.iso.date(),
  }),
  budget: z
    .strictObject({
      pagesPerTask: z.number().int().min(1).max(30).default(8),
      pagesPerDay: z.number().int().min(1).max(200).default(40),
      minIntervalMs: z.number().int().min(1_000).max(60_000).default(3_000),
    })
    .prefault({}),
  signIn: z.strictObject({ required: z.boolean(), handoffNote: z.string().max(300).optional() }).optional(),
  search: z.strictObject({ urlTemplate: z.string().max(500), params: z.array(z.string().max(30)).max(8) }).optional(),
  extract: z
    .strictObject({ jsonLdTypes: z.array(z.string().max(40)).max(8), resultSchema: z.record(z.string(), z.unknown()).optional() })
    .optional(),
  /** Generalises places' revision-1 `booking`; only with mode `stage`. */
  stage: z
    .strictObject({
      fillable: z.array(z.string().regex(/^[a-z_]{1,32}$/)).max(24),
      finalStep: z.strictObject({
        labels: z.array(z.string().max(60)).min(1).max(12),
        urlPatterns: z.array(z.string().max(200)).max(5).default([]),
        /** CSS for the final control, where its label or type says nothing (Lever's `#btn-submit`, a `type="button"`). */
        selectors: z.array(z.string().max(200)).max(8).optional(),
        /** Headings of the last step, where Next and Submit share one element and the URL does not change (Workday's "Review"). */
        stepHeadings: z.array(z.string().max(80)).max(8).optional(),
      }),
      /** Final steps reached per day, per profile (counted in `site_usage`). */
      perDay: z.number().int().min(1).max(25).default(10),
    })
    .optional(),
  notes: z.string().max(600),
});

/** A `booking` key (places' own revision-1 files) is read as `stage`, then dropped. */
const withStageAlias = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("booking" in value)) return value;
  const { booking, ...rest } = value as Record<string, unknown>;
  return "stage" in rest ? value : { ...rest, stage: booking };
};

export const SiteProfileSchema = z.preprocess(
  withStageAlias,
  SiteProfileObjectSchema.superRefine((profile, context) => {
    if (profile.stage !== undefined && profile.access.mode !== "stage")
      context.addIssue({ code: "custom", path: ["stage"], message: 'a stage section needs access.mode "stage"' });
    if (profile.access.watchable && (profile.access.mode !== "read" || profile.signIn?.required === true))
      context.addIssue({
        code: "custom",
        path: ["access", "watchable"],
        message: 'a watchable site has access.mode "read" and needs no sign-in',
      });
    if (!profile.access.navigate && profile.access.mode !== "assist-only")
      context.addIssue({ code: "custom", path: ["access", "navigate"], message: 'navigate: false needs access.mode "assist-only"' });
    for (const host of profile.hosts)
      if (siteWildcardTooWide(host))
        context.addIssue({ code: "custom", path: ["hosts"], message: `${host} covers many owners' sites: name the site's own domain` });
  }),
);
export type SiteProfile = z.infer<typeof SiteProfileSchema>;

/** Whether `host` is one a profile's `hosts` names: exact, or under a `*.suffix`. */
export function siteHostMatches(host: string, pattern: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!pattern.startsWith("*.")) return name === pattern;
  const suffix = pattern.slice(1);
  return name.endsWith(suffix) && name.length > suffix.length;
}

/** A profile an operator turned on, with the plugin that ships it. */
export interface EnabledSiteProfile {
  readonly pluginId: string;
  readonly profile: SiteProfile;
}

/** The enabled profile whose hosts name `url`'s host, if any; an exact host wins over a suffix. */
export function siteProfileFor(profiles: readonly EnabledSiteProfile[], url: string): EnabledSiteProfile | undefined {
  const host = hostOfUrl(url);
  if (host === undefined) return undefined;
  return (
    profiles.find((entry) => entry.profile.hosts.some((pattern) => !pattern.startsWith("*.") && siteHostMatches(host, pattern))) ??
    profiles.find((entry) => entry.profile.hosts.some((pattern) => siteHostMatches(host, pattern)))
  );
}

/** A profile's key in `site_usage` and in per-task state: `<plugin>/<profile>`. */
export const siteProfileKey = (entry: EnabledSiteProfile): string => `${entry.pluginId}/${entry.profile.id}`;

/** A profile's counts for one UTC day (`site_usage`): pages read, and final steps reached (staging). */
export interface SiteUsage {
  readonly pages: number;
  readonly finalSteps: number;
}

export type SiteUsageCounter = "pages" | "finalSteps";

interface SiteUsageRepositoryPortDefinition {
  /** Counts one against `counter` for the profile's day when it is under `limit`; `ok: false` and nothing counted otherwise. */
  take(input: {
    readonly workspaceId: string;
    readonly profile: string;
    readonly day: string;
    readonly counter: SiteUsageCounter;
    readonly limit: number;
  }): { readonly ok: boolean; readonly usage: SiteUsage };
  get(workspaceId: string, profile: string, day: string): SiteUsage;
  /** Drops days before `before` (a UTC day); how many rows went. */
  prune(before: string): number;
}

export type SiteUsageRepositoryPort = AsyncRepository<SiteUsageRepositoryPortDefinition>;
