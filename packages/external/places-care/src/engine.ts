import { definedOnly, errorMessage, nowTimestamp } from "@tavi/contracts/util";
import {
  createBudgetLedger,
  delay,
  type BudgetLedger,
  type CallContext,
  type Fetched,
  type Fetcher as DomainFetcher,
} from "@tavi/domain-kit";
import {
  cmsDcRecord,
  cmsDcRequest,
  DAILY_BUDGET_SPENT,
  pausedOutcome,
  withExhaustion,
  InNetworkInputSchema,
  networkMatch,
  type NetworkMatch,
  planHasWords,
  npiRecord,
  npiRequest,
  openPlacesStore,
  parseBundle,
  parseCmsDc,
  parseNpi,
  payerRecord,
  planNetRequests,
  ProvidersInputSchema,
  RegistryCheckInputSchema,
  roleNetworkIds,
  SOURCE_PAUSE_MS,
  type Payer,
  type PlacesRequest,
  type PlacesSourceRecord,
  type PlacesStore,
  type ProviderRecord,
} from "@tavi/places-kit";

import { PAYERS } from "./payers.js";

/**
 * The `places.care` tools' work, apart from the plugin context so it is tested with a fake network.
 * Every request goes through its source's budget and health and is logged by
 * host only: no provider, plan or person's detail is kept.
 */

export type { CallContext, Fetched } from "@tavi/domain-kit";
export type Fetcher = DomainFetcher<PlacesRequest>;

export interface CareEngineOptions {
  /** `care.db` in the worker's home: budgets, health and the request log. */
  readonly storePath: string;
  readonly fetcher: Fetcher;
  readonly config: Readonly<Record<string, unknown>>;
  readonly version: string;
  readonly now?: () => string;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly payers?: readonly Payer[];
}

type SourceReport = { readonly source: string; readonly outcome: string; readonly found?: number };

/** Pages of roles or networks one provider reads at most. */
const PAGES_MAX = 4;
/** The longest one tool call runs. */
const DEADLINE_MS = 45_000;
/** The longest a call waits for a source's per-second rate. */
const RATE_WAIT_MAX_MS = 5_000;

const NOT_A_NETWORK =
  "The NPI Registry and Medicare's file say who a provider is, not which insurance networks they are in: ask in_network for a payer's directory";

/** What `in_network` answers for one provider. */
export interface InNetworkRow {
  readonly npi: string;
  /**
   * `listed`: in a network whose name carries the plan's distinctive words, of the providers' state (or none named) and the plan's line of cover;
   * `possible`: only in networks matched on plan-type words alone ("Medicare PPO"), or naming a state when none was given;
   * `other_networks`: listed, in none of those; `not_listed`: the directory has no such practitioner; `unknown`: the directory did not say, or named no network.
   */
  readonly status: "listed" | "possible" | "other_networks" | "not_listed" | "unknown";
  readonly matchedNetworks: readonly string[];
  readonly otherNetworks: readonly string[];
  readonly note?: string;
}

/** What a `possible` row's matches prove: a match by name on plan-type words or with a state unknown, never the plan confirmed. */
function possibleNotes(matches: readonly Extract<NetworkMatch, { kind: "possible" }>[]): string[] {
  const notes: string[] = [];
  const typeOnly = matches.find((match) => match.why === "type-only");
  if (typeOnly !== undefined) {
    const words = typeOnly.words.map((word) => (word.length <= 4 ? word.toUpperCase() : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`));
    notes.push(
      `Matched by plan type alone (${words.join(", ")}): many plans share those words, so this is a match by name, not the directory confirming your plan`,
    );
  }
  const states = [...new Set(matches.flatMap((match) => (match.why === "state" ? [match.state] : [])))];
  if (states.length > 0)
    notes.push(
      `The matching network names ${states.join(" and ")}, and no state was given for this provider: it may be another state's network, so this is a match by name, not the directory confirming your plan`,
    );
  return notes;
}

export function createCareEngine(options: CareEngineOptions) {
  const now = options.now ?? nowTimestamp;
  const sleep = options.sleep ?? delay;
  const payers = options.payers ?? PAYERS;
  const records = new Map<string, PlacesSourceRecord>([
    [npiRecord.id, npiRecord],
    [cmsDcRecord.id, cmsDcRecord],
  ]);
  for (const payer of payers) {
    const record = payerRecord(payer);
    if (record !== undefined) records.set(record.id, record);
  }
  // No contact: a health lookup's User-Agent never names the person beside the doctors they look up.
  const userAgent = `Tavi-places/${options.version}`;
  let opened: { readonly store: PlacesStore; readonly budgets: BudgetLedger } | undefined;
  const open = () => {
    if (opened === undefined) {
      // The places store's tables, of which only health, budgets and the log are used: nothing about a provider is kept.
      const store = openPlacesStore(options.storePath, new Map());
      opened = { store, budgets: createBudgetLedger(store.db) };
    }
    return opened;
  };

  const refusal = (record: PlacesSourceRecord, context: CallContext): string | undefined => {
    if (record.terms.userTriggeredOnly && context.unattended) return "skipped: its terms allow only requests a person makes";
    const health = open().store.health(record.id, now());
    if (health.disabledUntil !== undefined && Date.parse(health.disabledUntil) > Date.parse(now()))
      return pausedOutcome(health.disabledUntil);
    return undefined;
  };

  /** One request through its source's budget, its outcome marked on its health, logged by host. */
  const send = async (
    record: PlacesSourceRecord,
    request: PlacesRequest,
    signal: AbortSignal,
  ): Promise<Fetched | { readonly skipped: string }> => {
    const { store, budgets } = open();
    let budget = budgets.take(record.id, record.budget, Date.parse(now()));
    // A per-second rate is waited out briefly; a daily budget is not.
    for (
      let waits = 0;
      !budget.ok && budget.reason === "per-second" && budget.retryAfterMs <= RATE_WAIT_MAX_MS && waits < 3 && !signal.aborted;
      waits += 1
    ) {
      await sleep(budget.retryAfterMs, signal);
      budget = budgets.take(record.id, record.budget, Date.parse(now()));
    }
    if (signal.aborted) return { skipped: "ran out of time" };
    if (!budget.ok) return { skipped: budget.reason === "per-day" ? DAILY_BUDGET_SPENT : "skipped: its rate limit" };
    const at = now();
    try {
      const fetched = await options.fetcher({ ...request, headers: { "User-Agent": userAgent, ...request.headers } }, signal);
      store.log({ source: record.id, host: new URL(request.url).host, at, status: fetched.status, bytes: fetched.bytes });
      return fetched;
    } catch (error) {
      store.log({ source: record.id, host: new URL(request.url).host, at, status: 0, bytes: 0 });
      if (signal.aborted) return { skipped: "ran out of time" };
      const message = errorMessage(error);
      store.recordOutcome(record.id, { ok: false, error: message }, at);
      return { skipped: `failed: ${message.slice(0, 200)}` };
    }
  };
  const mark = (record: PlacesSourceRecord, kind: string, detail?: string): void => {
    const { store } = open();
    const at = now();
    if (kind === "ok" || kind === "not-found") store.recordOutcome(record.id, { ok: true }, at);
    else if (kind === "drift") {
      store.recordOutcome(record.id, { ok: false, drift: true, error: detail ?? "drift" }, at);
      store.pause(record.id, new Date(Date.parse(at) + SOURCE_PAUSE_MS).toISOString(), at);
    } else store.recordOutcome(record.id, { ok: false, error: kind }, at);
  };

  /** NPPES, then CMS's Medicare record for the providers found. */
  const lookUp = async (
    query: Parameters<typeof npiRequest>[0],
    limit: number,
    signal: AbortSignal,
    context: CallContext,
    reports: SourceReport[],
  ): Promise<ProviderRecord[]> => {
    const why = refusal(npiRecord, context);
    if (why !== undefined) {
      reports.push({ source: npiRecord.id, outcome: why });
      return [];
    }
    const fetched = await send(npiRecord, npiRequest(query, limit), signal);
    if ("skipped" in fetched) {
      reports.push({ source: npiRecord.id, outcome: fetched.skipped });
      return [];
    }
    const outcome = parseNpi(fetched, now());
    if (outcome.kind === "refused") {
      // The registry declining a query is the query's doing, not the registry failing.
      reports.push({ source: npiRecord.id, outcome: `refused: ${outcome.detail}` });
      return [];
    }
    mark(npiRecord, outcome.kind, "detail" in outcome ? outcome.detail : undefined);
    if (outcome.kind !== "ok") {
      reports.push({ source: npiRecord.id, outcome: outcome.kind });
      return [];
    }
    reports.push({ source: npiRecord.id, outcome: "ok", found: outcome.providers.length });
    const individuals = outcome.providers.filter((provider) => provider.kind === "individual").map((provider) => provider.npi);
    const request = cmsDcRequest(individuals);
    if (request === undefined) return outcome.providers;
    const paused = refusal(cmsDcRecord, context);
    if (paused !== undefined) {
      reports.push({ source: cmsDcRecord.id, outcome: paused });
      return outcome.providers;
    }
    const medicare = await send(cmsDcRecord, request, signal);
    if ("skipped" in medicare) {
      reports.push({ source: cmsDcRecord.id, outcome: medicare.skipped });
      return outcome.providers;
    }
    const enriched = parseCmsDc(medicare, now());
    mark(cmsDcRecord, enriched.kind, "detail" in enriched ? enriched.detail : undefined);
    if (enriched.kind !== "ok") {
      reports.push({ source: cmsDcRecord.id, outcome: enriched.kind });
      return outcome.providers;
    }
    reports.push({ source: cmsDcRecord.id, outcome: "ok", found: enriched.byNpi.size });
    return outcome.providers.map((provider) => {
      const record = enriched.byNpi.get(provider.npi);
      return record === undefined ? provider : { ...provider, medicare: record };
    });
  };
  const attribution = (reports: readonly SourceReport[]): string[] => [
    ...new Set(
      reports
        .filter((report) => report.outcome === "ok")
        .flatMap((report) => {
          const record = records.get(report.source);
          return record === undefined ? [] : [record.terms.attribution, ...record.terms.displayRules];
        }),
    ),
  ];

  return {
    /** Providers of a specialty in a US postcode or city (NPPES, then Medicare's file). */
    async providers(input: unknown, signal: AbortSignal, context: CallContext) {
      const query = ProvidersInputSchema.parse(input);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]);
      const reports: SourceReport[] = [];
      const providers = await lookUp(
        { specialty: query.specialty, ...definedOnly({ postcode: query.postcode, city: query.city, state: query.state }) },
        query.limit,
        deadline,
        context,
        reports,
      );
      const shown = attribution(reports);
      return {
        providers: providers.filter((provider) => provider.status === "active").slice(0, query.limit),
        sources: withExhaustion(reports, now()),
        ...(shown.length === 0 ? {} : { attribution: shown }),
        note: NOT_A_NETWORK,
      };
    },

    /** A provider's registry record by NPI or name: status, taxonomies with their state licences, where they practise. */
    async registryCheck(input: unknown, signal: AbortSignal, context: CallContext) {
      const query = RegistryCheckInputSchema.parse(input);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]);
      const reports: SourceReport[] = [];
      const providers = await lookUp(
        definedOnly({
          number: query.npi,
          firstName: query.firstName,
          lastName: query.lastName,
          organization: query.organization,
          state: query.state,
        }),
        10,
        deadline,
        context,
        reports,
      );
      const shown = attribution(reports);
      const note =
        providers.length === 0 && reports.some((report) => report.source === npiRecord.id && report.outcome === "ok")
          ? `No provider in the NPI Registry matches. ${NOT_A_NETWORK}`
          : `A state licence number is as the provider submitted it; the state board's own search is the record. ${NOT_A_NETWORK}`;
      return { providers, sources: withExhaustion(reports, now()), ...(shown.length === 0 ? {} : { attribution: shown }), note };
    },

    /**
     * Whether providers are in a plan's network, from the payer's Plan-Net
     * directory: each provider's networks by name, matched against the plan's
     * distinctive words. A payer without a directory that answers by NPI gets
     * its own directory's page to check in the browser.
     */
    async inNetwork(input: unknown, signal: AbortSignal, context: CallContext) {
      const query = InNetworkInputSchema.parse(input);
      const payer = payers.find((each) => each.id === query.payer);
      if (payer === undefined)
        return {
          payer: query.payer,
          plan: query.plan,
          rows: [] as InNetworkRow[],
          sources: [] as SourceReport[],
          note: `Tavi does not know ${query.payer}'s directory: check the payer's own provider directory in the browser. Known payers: ${payers.map((each) => each.id).join(", ")}`,
        };
      const record = payerRecord(payer);
      if (record === undefined)
        return {
          payer: payer.id,
          plan: query.plan,
          rows: [] as InNetworkRow[],
          sources: [] as SourceReport[],
          verifyUrl: payer.directoryUrl,
          note: `${payer.name}'s published directory does not answer a provider by NPI: check ${payer.directoryUrl} in the browser`,
        };
      if (!planHasWords(query.plan, payer.name))
        return {
          payer: payer.id,
          plan: query.plan,
          rows: [] as InNetworkRow[],
          sources: [] as SourceReport[],
          verifyUrl: payer.directoryUrl,
          note: `Give the plan's name as printed on the card (such as "Gold Plus" or "Medicare PPO"): "${query.plan}" names only the payer`,
        };
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]);
      const reports: SourceReport[] = [];
      const why = refusal(record, context);
      if (why !== undefined)
        return {
          payer: payer.id,
          plan: query.plan,
          rows: [] as InNetworkRow[],
          sources: withExhaustion([{ source: record.id, outcome: why }], now()),
          verifyUrl: payer.directoryUrl,
          note: `The directory was not asked (${why}): check ${payer.directoryUrl}`,
        };
      const ask = async (request: PlacesRequest, type: string) => {
        const fetched = await send(record, request, deadline);
        if ("skipped" in fetched) return { kind: "skipped" as const, reason: fetched.skipped };
        const parsed = parseBundle(fetched, now(), type);
        mark(record, parsed.kind, "detail" in parsed ? parsed.detail : undefined);
        return parsed;
      };
      /** Every page of a search, up to `PAGES_MAX`, following the directory's next links on its own host. */
      const askAll = async (request: PlacesRequest, type: string) => {
        const resources: Record<string, unknown>[] = [];
        let page: PlacesRequest | undefined = request;
        for (let pages = 0; page !== undefined; pages += 1) {
          const answer = await ask(page, type);
          if (answer.kind !== "ok") return answer;
          resources.push(...answer.resources);
          if (answer.next !== undefined && pages + 1 >= PAGES_MAX) return { kind: "ok" as const, resources, partial: true };
          page = answer.next === undefined ? undefined : planNetRequests.next(payer, answer.next);
        }
        return { kind: "ok" as const, resources, partial: false };
      };
      const rows: InNetworkRow[] = [];
      for (const npi of [...new Set(query.providers)]) {
        const unknown = (note: string): InNetworkRow => ({ npi, status: "unknown", matchedNetworks: [], otherNetworks: [], note });
        const practitioners = await ask(planNetRequests.practitioner(payer, npi), "Practitioner");
        if (practitioners.kind !== "ok") {
          rows.push(unknown(practitioners.kind === "skipped" ? practitioners.reason : `the directory answered ${practitioners.kind}`));
          continue;
        }
        const id = practitioners.resources[0]?.["id"];
        if (typeof id !== "string") {
          rows.push({
            npi,
            status: "not_listed",
            matchedNetworks: [],
            otherNetworks: [],
            note: "The directory lists no practitioner with this NPI",
          });
          continue;
        }
        const roles = await askAll(planNetRequests.roles(payer, id), "PractitionerRole");
        if (roles.kind !== "ok") {
          rows.push(unknown(roles.kind === "skipped" ? roles.reason : `the directory answered ${roles.kind}`));
          continue;
        }
        const ids = roleNetworkIds(roles.resources);
        if (ids.length === 0) {
          rows.push(unknown("The directory lists this practitioner with no network"));
          continue;
        }
        const networks = await askAll(planNetRequests.networks(payer, ids), "Organization");
        if (networks.kind !== "ok") {
          rows.push(unknown(networks.kind === "skipped" ? networks.reason : `the directory answered ${networks.kind}`));
          continue;
        }
        const names = [
          ...new Set(networks.resources.map((network) => network["name"]).filter((name): name is string => typeof name === "string")),
        ].sort();
        const matches = names.map((name) => ({ name, match: networkMatch(name, query.plan, payer.name, query.state) }));
        const definite = matches.filter((each) => each.match.kind === "match").map((each) => each.name);
        const possible = matches.flatMap((each) => (each.match.kind === "possible" ? [{ name: each.name, match: each.match }] : []));
        const matched = definite.length > 0 ? definite : possible.map((each) => each.name);
        const partial = roles.partial || networks.partial;
        const notes = [
          ...(definite.length === 0 ? possibleNotes(possible.map((each) => each.match)) : []),
          ...(partial ? [`The directory has more than ${String(PAGES_MAX)} pages for this practitioner: only those were read`] : []),
        ];
        rows.push({
          npi,
          status: definite.length > 0 ? "listed" : possible.length > 0 ? "possible" : "other_networks",
          matchedNetworks: matched,
          otherNetworks: names.filter((name) => !matched.includes(name)).slice(0, 20),
          ...(notes.length === 0 ? {} : { note: notes.join(". ") }),
        });
      }
      reports.push({
        source: record.id,
        outcome: rows.every((row) => row.status === "unknown") ? "failed" : "ok",
        found: rows.filter((row) => row.status === "listed").length,
      });
      return {
        payer: payer.id,
        plan: query.plan,
        rows,
        sources: withExhaustion(reports, now()),
        attribution: [record.terms.attribution, ...record.terms.displayRules],
        verifyUrl: payer.directoryUrl,
        note: `A match is by the network's name against your plan's words, never the directory confirming your plan: listed means a network's name carries your plan's own words, possible a weaker match by name, said on the row; confirm with the office and the payer, which the directory itself asks. Employer plans may not be in this directory${query.state === undefined ? ". No state was given, so a network naming one is only possible" : ""}`,
      };
    },

    sources() {
      const { store, budgets } = open();
      const at = now();
      return {
        sources: [...records.values()].map((record) => ({
          id: record.id,
          name: record.name,
          terms: {
            url: record.terms.url,
            reviewedAt: record.terms.reviewedAt,
            licence: record.terms.licence,
            attribution: record.terms.attribution,
            displayRules: record.terms.displayRules,
          },
          budget: {
            ...record.budget,
            usedToday: budgets.peek(record.id)?.day === at.slice(0, 10) ? (budgets.peek(record.id)?.usedToday ?? 0) : 0,
          },
          health: store.health(record.id, at),
        })),
        payers: payers.map((payer) => ({
          id: payer.id,
          name: payer.name,
          directory: payer.fhirBase === undefined ? "browser" : "plan-net",
          directoryUrl: payer.directoryUrl,
        })),
        recentRequests: store.recentRequests(20),
      };
    },

    close() {
      opened?.store.close();
      opened = undefined;
    },
  };
}

export type CareEngine = ReturnType<typeof createCareEngine>;
