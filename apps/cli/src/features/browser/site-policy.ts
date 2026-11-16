import {
  hostOfUrl,
  robotsAllows,
  type FinalStepRule,
  siteProfileFor,
  siteProfileKey,
  type EnabledSiteProfile,
  type PluginManifest,
  type SiteProfile,
  type SiteUsage,
  type SiteUsageCounter,
  type TaskFindingRepositoryPort,
} from "@tavi/contracts";

/**
 * The site profiles' rules, in
 * one place the browser tools ask: what a profiled host allows, its budgets,
 * robots.txt for unattended reads, and a block ending the site for a task.
 * A host no enabled profile names keeps today's behaviour.
 */

/** robots.txt answers kept this long. */
const ROBOTS_CACHE_MS = 24 * 3_600_000;
/** A robots.txt that could not be read is tried again after this; meanwhile it disallows. */
const ROBOTS_RETRY_MS = 3_600_000;
const ROBOTS_TIMEOUT_MS = 5_000;
const ROBOTS_MAX_BYTES = 512 * 1024;
const ROBOTS_REDIRECTS_MAX = 5;
/** What RFC 9309 reads an unreachable robots.txt as: everything disallowed. */
const DISALLOW_ALL = "User-agent: *\nDisallow: /\n";
/** Tasks whose per-task state is kept; the oldest goes first. */
const TASKS_MAX = 500;

/** A site's robots.txt: its text, none (any 4xx: no rule), or that it could not be read. */
export type RobotsAnswer = { readonly text: string } | { readonly none: true } | { readonly unreadable: true };

export interface SitePolicyOptions {
  /** The profiles the operator turned on, with their plugins (read fresh each call, so a switch takes effect at once). */
  readonly profiles: () => Promise<readonly EnabledSiteProfile[]>;
  readonly usage: {
    readonly take: (input: {
      readonly workspaceId: string;
      readonly profile: string;
      readonly day: string;
      readonly counter: SiteUsageCounter;
      readonly limit: number;
    }) => Promise<{ readonly ok: boolean; readonly usage: SiteUsage }>;
    readonly get: (workspaceId: string, profile: string, day: string) => Promise<SiteUsage>;
  };
  readonly robots: (origin: string, signal: AbortSignal) => Promise<RobotsAnswer>;
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Why a call on a profiled host is refused, and when its budget resets, if that is the cause. */
interface SiteRefusal {
  readonly refused: string;
  readonly host: string;
  readonly budgetExhausted?: true;
  readonly resetsAt?: string;
}

interface TaskState {
  readonly pages: Map<string, number>;
  readonly lastAt: Map<string, number>;
  /** Profiles a block ended for this task. */
  readonly ended: Map<string, string>;
}

export interface SitePolicy {
  /** The enabled profile naming `url`'s host, if any. */
  profileFor(url: string | undefined): Promise<EnabledSiteProfile | undefined>;
  /** Whether a destination is allowed because an enabled profile names it for navigation: never wider than profile-driven browsing. */
  allowsDestination(url: string): Promise<boolean>;
  /** The same, from the profiles last read: for an assessment, which cannot wait. The handler asks again with `allowsDestination`. */
  allowsDestinationNow(url: string): boolean;
  /** Reads the enabled profiles again (at start, and after the operator changes them). */
  refresh(): Promise<void>;
  /** Before a navigation: its rules and budgets (rules 3, 5, 9, 10, 11). Counts the page when it is allowed, after any courtesy wait. */
  beforeNavigate(input: {
    readonly workspaceId: string;
    readonly taskId: string;
    readonly url: string;
    readonly unattended: boolean;
    readonly signal: AbortSignal;
  }): Promise<SiteRefusal | undefined>;
  /**
   * A page an action led to (a click, a redirect) on another profiled page: the same rules as a navigation, counted
   * when it is reached, with no wait (it is already open). A refusal means its content is not returned.
   */
  pageReached(input: {
    readonly workspaceId: string;
    readonly taskId: string;
    readonly from: string | undefined;
    readonly url: string | undefined;
    readonly unattended: boolean;
    readonly signal: AbortSignal;
  }): Promise<SiteRefusal | undefined>;
  /** `act`, `extract` and `vision_act` on a page: refused on a `navigate: false` host, and on a host a block ended for the task. */
  refuseOnPage(input: {
    readonly taskId: string;
    readonly url: string | undefined;
    readonly tool: "act" | "extract" | "vision_act";
  }): Promise<SiteRefusal | undefined>;
  /** A `stage` profile's final step for a page, from the profiles last read: for an observation's tags. */
  finalStepRuleNow(url: string | undefined): FinalStepRule | undefined;
  /** The same, read fresh: what the browser re-checks before a press. */
  finalStepRule(url: string | undefined): Promise<FinalStepRule | undefined>;
  /**
   * A final step reached: its page observed with the step on it, or its press refused. Counted once per
   * session and page against the profile's `stage.perDay`, whichever came first and however often it is retried.
   */
  finalStepReached(input: { readonly workspaceId: string; readonly sessionId: string; readonly url: string | undefined }): Promise<void>;
  /** Refuses acting on a `stage` site whose final steps for today are used (`stage.perDay`). */
  stageRefusal(input: { readonly workspaceId: string; readonly url: string | undefined }): Promise<SiteRefusal | undefined>;
  /** Whether a page's host is `assist-only` or `navigate: false`: read for the turn, never kept. */
  readOnlyForTurn(url: string | undefined): Promise<boolean>;
  /** A captcha, bot wall or rate limit on a profiled page ends the site for the task. */
  blocked(input: { readonly taskId: string; readonly url: string | undefined; readonly kind: string }): Promise<void>;
  taskEnded(taskId: string): void;
}

const nextUtcDay = (ms: number): string => {
  const day = new Date(ms);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1)).toISOString();
};
const BLOCKS_ENDING_A_SITE: ReadonlySet<string> = new Set(["captcha", "bot-wall", "rate-limit"]);

/** A `stage` profile's final step, in the guard's terms. */
function finalStepOf(entry: EnabledSiteProfile | undefined): FinalStepRule | undefined {
  const stage = entry?.profile.access.mode === "stage" ? entry.profile.stage : undefined;
  if (stage === undefined) return undefined;
  const { labels, urlPatterns, selectors, stepHeadings } = stage.finalStep;
  return {
    labels,
    urlPatterns,
    ...(selectors === undefined ? {} : { selectors }),
    ...(stepHeadings === undefined ? {} : { stepHeadings }),
  };
}

export function createSitePolicy(options: SitePolicyOptions): SitePolicy {
  const tasks = new Map<string, TaskState>();
  const robotsCache = new Map<string, { readonly text: string | undefined; readonly until: number }>();
  /** The final steps already counted, by session and page. */
  const finalStepsCounted = new Set<string>();
  const taskOf = (taskId: string): TaskState => {
    let state = tasks.get(taskId);
    if (state === undefined) {
      state = { pages: new Map(), lastAt: new Map(), ended: new Map() };
      tasks.set(taskId, state);
      if (tasks.size > TASKS_MAX) tasks.delete(tasks.keys().next().value ?? "");
    }
    return state;
  };
  let last: readonly EnabledSiteProfile[] = [];
  const current = async (): Promise<readonly EnabledSiteProfile[]> => {
    last = await options.profiles();
    return last;
  };
  const profileFor = async (url: string | undefined): Promise<EnabledSiteProfile | undefined> =>
    url === undefined ? undefined : siteProfileFor(await current(), url);
  /** A site's robots.txt text, or `undefined` for none; one that could not be read reads as disallowing all, for an hour. */
  const robotsOf = async (origin: string, signal: AbortSignal): Promise<string | undefined> => {
    const cached = robotsCache.get(origin);
    if (cached !== undefined && options.now() < cached.until) return cached.text;
    const answer = await options.robots(origin, signal);
    const text = "text" in answer ? answer.text : "unreadable" in answer ? DISALLOW_ALL : undefined;
    robotsCache.set(origin, { text, until: options.now() + ("unreadable" in answer ? ROBOTS_RETRY_MS : ROBOTS_CACHE_MS) });
    return text;
  };
  /** The rules a page on a profiled host is held to, before or after it opens; `wait` waits out the courtesy interval. */
  const check = async (input: {
    readonly workspaceId: string;
    readonly taskId: string;
    readonly url: string;
    readonly unattended: boolean;
    readonly signal: AbortSignal;
    readonly wait: boolean;
    readonly opened: boolean;
  }): Promise<SiteRefusal | undefined> => {
    const entry = await profileFor(input.url);
    if (entry === undefined) return undefined;
    const { profile } = entry;
    const host = hostOfUrl(input.url) ?? "";
    const key = siteProfileKey(entry);
    const task = taskOf(input.taskId);
    const ended = task.ended.get(key);
    if (ended !== undefined)
      return {
        refused: `${profile.name} showed a ${ended} in this task: hand it to the person with browser.request_handoff, or use another source`,
        host,
      };
    if (!profile.access.navigate || profile.access.mode === "none")
      return {
        refused: `${profile.name} is not browsed by Tavi: ${profile.access.mode === "none" ? "its profile is a link only" : "only a page the person opened is read"} (${profile.access.reason})`,
        host,
      };
    if (input.unattended) {
      // No unattended read but of a watchable profile, and only a path its robots.txt allows.
      if (!profile.access.watchable) return { refused: `${profile.name} is read only while the person attends`, host };
      const parsed = URL.parse(input.url);
      if (parsed === null) return { refused: "that is not a URL Tavi can read", host };
      const robots = await robotsOf(parsed.origin, input.signal);
      if (robots !== undefined && !robotsAllows(robots, `${parsed.pathname}${parsed.search}`))
        return { refused: `${host}'s robots.txt disallows ${parsed.pathname}, so it is not read unattended`, host };
      // A site whose robots.txt disallows the profile's own search path is not watchable at all.
      const searchPath =
        profile.search === undefined
          ? undefined
          : URL.parse(profile.search.urlTemplate.replace(/\{[^}]*\}/g, "x"), parsed.origin)?.pathname;
      if (robots !== undefined && searchPath !== undefined && !robotsAllows(robots, searchPath))
        return { refused: `${host}'s robots.txt disallows its search (${searchPath}), so ${profile.name} is not watched`, host };
    }
    const pages = task.pages.get(key) ?? 0;
    if (pages >= profile.budget.pagesPerTask)
      return {
        refused: `${profile.name}'s ${String(profile.budget.pagesPerTask)} pages for this task are used`,
        host,
        budgetExhausted: true,
      };
    // A courtesy floor between pages, waited out (no jitter).
    const since = options.now() - (task.lastAt.get(key) ?? Number.NEGATIVE_INFINITY);
    if (input.wait && since < profile.budget.minIntervalMs) await options.sleep(profile.budget.minIntervalMs - since, input.signal);
    const day = new Date(options.now()).toISOString().slice(0, 10);
    const taken = await options.usage.take({
      workspaceId: input.workspaceId,
      profile: key,
      day,
      counter: "pages",
      limit: profile.budget.pagesPerDay,
    });
    if (!taken.ok)
      return {
        refused: `${profile.name}'s ${String(profile.budget.pagesPerDay)} pages for today are used`,
        host,
        budgetExhausted: true,
        resetsAt: nextUtcDay(options.now()),
      };
    task.pages.set(key, pages + 1);
    task.lastAt.set(key, options.now());
    return undefined;
  };

  return {
    profileFor,
    allowsDestination: async (url) => (await profileFor(url))?.profile.access.navigate === true,
    allowsDestinationNow: (url) => siteProfileFor(last, url)?.profile.access.navigate === true,
    refresh: async () => void (await current()),
    beforeNavigate: (input) => check({ ...input, wait: true, opened: false }),
    async pageReached({ from, url, ...input }) {
      // Only a page that moved: a click that stays on the page is not another page.
      if (url === undefined || url === from) return undefined;
      return check({ ...input, url, wait: false, opened: true });
    },
    async refuseOnPage({ taskId, url, tool }) {
      const entry = await profileFor(url);
      if (entry === undefined) return undefined;
      const host = hostOfUrl(url) ?? "";
      const ended = taskOf(taskId).ended.get(siteProfileKey(entry));
      if (ended !== undefined)
        return {
          refused: `${entry.profile.name} showed a ${ended} in this task: hand it to the person with browser.request_handoff`,
          host,
        };
      if (!entry.profile.access.navigate)
        return {
          refused: `browser.${tool} is refused on ${entry.profile.name}: Tavi reads only the page the person opened there, with browser.structured, browser.observe or browser.read`,
          host,
        };
      return undefined;
    },
    finalStepRuleNow: (url) => (url === undefined ? undefined : finalStepOf(siteProfileFor(last, url))),
    finalStepRule: async (url) => finalStepOf(await profileFor(url)),
    async finalStepReached({ workspaceId, sessionId, url }) {
      const entry = await profileFor(url);
      const stage = entry?.profile.access.mode === "stage" ? entry.profile.stage : undefined;
      if (entry === undefined || stage === undefined || url === undefined) return;
      const reached = `${sessionId}|${url}`;
      if (finalStepsCounted.has(reached)) return;
      finalStepsCounted.add(reached);
      if (finalStepsCounted.size > TASKS_MAX * 4) finalStepsCounted.delete(finalStepsCounted.values().next().value ?? "");
      await options.usage.take({
        workspaceId,
        profile: siteProfileKey(entry),
        day: new Date(options.now()).toISOString().slice(0, 10),
        counter: "finalSteps",
        limit: stage.perDay,
      });
    },
    async stageRefusal({ workspaceId, url }) {
      const entry = await profileFor(url);
      const stage = entry?.profile.access.mode === "stage" ? entry.profile.stage : undefined;
      if (entry === undefined || stage === undefined) return undefined;
      const used = await options.usage.get(workspaceId, siteProfileKey(entry), new Date(options.now()).toISOString().slice(0, 10));
      return used.finalSteps >= stage.perDay
        ? {
            refused: `${entry.profile.name}'s ${String(stage.perDay)} staged forms or bookings for today are reached`,
            host: hostOfUrl(url) ?? "",
            budgetExhausted: true,
            resetsAt: nextUtcDay(options.now()),
          }
        : undefined;
    },
    readOnlyForTurn: async (url) => {
      const entry = await profileFor(url);
      return entry !== undefined && (entry.profile.access.mode === "assist-only" || !entry.profile.access.navigate);
    },
    async blocked({ taskId, url, kind }) {
      if (!BLOCKS_ENDING_A_SITE.has(kind)) return;
      const entry = await profileFor(url);
      if (entry !== undefined) taskOf(taskId).ended.set(siteProfileKey(entry), kind);
    },
    taskEnded: (taskId) => void tasks.delete(taskId),
  };
}

/**
 * Reads a site's robots.txt from the owner, as RFC 9309 asks: a 4xx
 * is no rule; anything else that fails is unreadable. A redirect is followed
 * only within the site's own origin (at most five), so a site cannot point
 * the owner's request at another host; the body is read only up to 512 KiB.
 * `fetcher` is the owner's `pinnedFetch`, so the site's own name cannot be
 * resolved to a loopback, LAN or metadata address either: a refused address
 * reads as unreadable. It is required, so no caller reads robots.txt unpinned
 * by leaving it out.
 */
export function createRobotsReader(fetcher: typeof fetch): (origin: string, signal: AbortSignal) => Promise<RobotsAnswer> {
  return async (origin, signal) => {
    let url = `${origin}/robots.txt`;
    try {
      for (let hops = 0; hops <= ROBOTS_REDIRECTS_MAX; hops += 1) {
        const response = await fetcher(url, {
          headers: { "User-Agent": "Tavi" },
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(ROBOTS_TIMEOUT_MS)]),
        });
        if (response.status >= 300 && response.status < 400) {
          const next = URL.parse(response.headers.get("location") ?? "", url);
          await response.body?.cancel();
          if (next === null || next.origin !== origin) return { unreadable: true };
          url = next.href;
          continue;
        }
        if (response.status >= 400 && response.status < 500) {
          await response.body?.cancel();
          return { none: true };
        }
        if (!response.ok || response.body === null) {
          await response.body?.cancel();
          return { unreadable: true };
        }
        return { text: await boundedText(response.body, ROBOTS_MAX_BYTES) };
      }
      return { unreadable: true };
    } catch {
      return { unreadable: true };
    }
  };
}

/** A body's text up to `max` bytes; the rest is not read. */
async function boundedText(body: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value.subarray(0, max - bytes));
    bytes += chunk.value.byteLength;
    if (bytes >= max) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A running plugin, as the owner resolved it: what its site profiles are read from. */
export interface SitePluginSource {
  readonly pluginId: string;
  readonly version: string;
  readonly directory: string;
  readonly manifest: PluginManifest;
}

/**
 * The entries of one kind the operator turned on: those of a plugin that
 * runs — not one withdrawn since the owner started — read once per version
 * from its verified snapshot, and named by id in the operator's switch. Site
 * profiles and a plugin's site notes are both read this way.
 */
export function enabledPluginEntries<T extends { readonly id: string }>(input: {
  readonly plugins: () => readonly SitePluginSource[];
  readonly withdrawn: () => ReadonlySet<string>;
  readonly read: (directory: string, manifest: PluginManifest) => readonly T[];
}): (on: Readonly<Record<string, readonly string[]>>) => { readonly pluginId: string; readonly entry: T }[] {
  const cache = new Map<string, readonly T[]>();
  return (on) => {
    const withdrawn = input.withdrawn();
    return input.plugins().flatMap((plugin) => {
      const ids = on[plugin.pluginId];
      if (ids === undefined || ids.length === 0 || withdrawn.has(plugin.pluginId)) return [];
      const key = `${plugin.pluginId}@${plugin.version}`;
      let entries = cache.get(key);
      if (entries === undefined) {
        entries = input.read(plugin.directory, plugin.manifest);
        cache.set(key, entries);
      }
      return entries.filter((entry) => ids.includes(entry.id)).map((entry) => ({ pluginId: plugin.pluginId, entry }));
    });
  };
}

/** The profiles the operator turned on (`enabledPluginEntries`), the switch read afresh each time. */
export function enabledSiteProfiles(input: {
  readonly plugins: () => readonly SitePluginSource[];
  readonly withdrawn: () => ReadonlySet<string>;
  readonly sitesOn: () => Promise<Readonly<Record<string, readonly string[]>>>;
  readonly read: (directory: string, manifest: PluginManifest) => readonly SiteProfile[];
}): () => Promise<EnabledSiteProfile[]> {
  const entries = enabledPluginEntries(input);
  return async () => entries(await input.sitesOn()).map(({ pluginId, entry }) => ({ pluginId, profile: entry }));
}

/** What a site read for the turn only shows is never kept as a finding, by an extraction, the agent or a plugin. */
export function keepingFindings(
  findings: TaskFindingRepositoryPort,
  sites: Pick<SitePolicy, "readOnlyForTurn">,
): TaskFindingRepositoryPort {
  return {
    add: async (input) =>
      input.sourceUrl !== undefined && (await sites.readOnlyForTurn(input.sourceUrl)) ? [] : await findings.add(input),
    list: (input) => findings.list(input),
  };
}
