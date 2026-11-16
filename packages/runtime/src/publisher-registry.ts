/**
 * The curated publisher registry.
 *
 * Independence was a string heuristic: two sources counted as independent when
 * their registrable domains differed. That is wrong in both directions — a
 * syndicated copy on another domain counted as a second source, and a publisher
 * with several domains counted as two — and it cannot say "I do not know", which
 * is the answer most hosts deserve.
 *
 * The registry answers one question: *who publishes this host, and in what
 * capacity?* Membership is **evidence, not proof**: a host being listed means a
 * human reviewed it, not that its reporting is independent of anyone else's, and
 * the tests treat it that way. A host that is not listed is `unknown`, which is an
 * explicit state rather than a default that silently means "independent".
 *
 * This is a different policy from the egress allowlist in `@tavi/contracts`
 * (`ROUTINE_PRIMARY_SOURCE_POLICY` / `isPrimarySourceHost`), which decides which
 * hosts a routine may **fetch** in the `primary_sources` network mode. They are
 * separately reviewed, versioned lists and they legitimately disagree: permission
 * to reach a host is not a claim that the host is an independent publisher.
 * `arxiv.org` is egress-admitted — a preprint is primary material — but is an
 * `aggregator` here, because arXiv neither wrote nor reviewed the paper, so it may
 * be fetched and may not corroborate. The converse also holds: `reuters.com` is a
 * `publisher` here but is not egress-admitted, because fetching it is an operator
 * allowlist decision, not a registry one.
 */
export const PUBLISHER_REGISTRY_VERSION = 1;
export const PUBLISHER_REGISTRY_REVIEWED_AT = "2026-09-21";

export type PublisherOwnership = "publisher" | "syndicator" | "aggregator";
export interface PublisherRegistryEntry {
  /** Exact host, or a `*.suffix` form; matched in the operator's allowlist language. */
  readonly host: string;
  /** The organisation the host belongs to, used to detect "two sources, one publisher". */
  readonly publisher: string;
  /**
   * `publisher` wrote the material, `syndicator` republished someone else's, and
   * `aggregator` collects links without adding reporting. Only the first can
   * contribute to independence.
   */
  readonly ownership: PublisherOwnership;
  /** Where the classification came from, so a reader can judge it. */
  readonly provenance: string;
}

export const PUBLISHER_REGISTRY: readonly PublisherRegistryEntry[] = Object.freeze([
  {
    host: "openai.com",
    publisher: "OpenAI",
    ownership: "publisher",
    provenance: "First-party announcements and research posts published on the lab's own site.",
  },
  { host: "anthropic.com", publisher: "Anthropic", ownership: "publisher", provenance: "First-party announcements and research posts." },
  { host: "blog.google", publisher: "Google", ownership: "publisher", provenance: "Google's own product blog; a Google-operated host." },
  {
    host: "deepmind.google",
    publisher: "Google DeepMind",
    ownership: "publisher",
    provenance: "DeepMind's own research site, operated by Google.",
  },
  { host: "research.google", publisher: "Google", ownership: "publisher", provenance: "Google Research's own publication." },
  { host: "github.blog", publisher: "GitHub", ownership: "publisher", provenance: "GitHub's own blog; a Microsoft-operated host." },
  { host: "blogs.microsoft.com", publisher: "Microsoft", ownership: "publisher", provenance: "Microsoft's own blog." },
  { host: "developer.nvidia.com", publisher: "NVIDIA", ownership: "publisher", provenance: "NVIDIA's own developer publication." },
  { host: "blogs.nvidia.com", publisher: "NVIDIA", ownership: "publisher", provenance: "NVIDIA's own blog." },
  { host: "ai.meta.com", publisher: "Meta", ownership: "publisher", provenance: "Meta AI's own site." },
  { host: "mistral.ai", publisher: "Mistral AI", ownership: "publisher", provenance: "The lab's own site." },
  { host: "cohere.com", publisher: "Cohere", ownership: "publisher", provenance: "The lab's own site." },
  { host: "stability.ai", publisher: "Stability AI", ownership: "publisher", provenance: "The lab's own site." },
  {
    host: "huggingface.co",
    publisher: "Hugging Face",
    ownership: "publisher",
    provenance: "Model-hub announcements and model cards; first-party for the hub, third-party for what users upload.",
  },
  {
    host: "arxiv.org",
    publisher: "arXiv",
    ownership: "aggregator",
    provenance: "A preprint archive: the paper's authors wrote it, the host did not review it.",
  },
  {
    host: "reuters.com",
    publisher: "Reuters",
    ownership: "publisher",
    provenance: "Wire service; its copy is widely syndicated, which is what `syndicator` hosts are detected against.",
  },
  { host: "techcrunch.com", publisher: "TechCrunch", ownership: "publisher", provenance: "Trade press with its own reporting." },
  { host: "theverge.com", publisher: "The Verge", ownership: "publisher", provenance: "Trade press with its own reporting." },
  {
    host: "news.ycombinator.com",
    publisher: "Hacker News",
    ownership: "aggregator",
    provenance: "A link aggregator: it adds no reporting of its own.",
  },
  { host: "reddit.com", publisher: "Reddit", ownership: "aggregator", provenance: "User-generated aggregation." },
  {
    host: "medium.com",
    publisher: "Medium",
    ownership: "syndicator",
    provenance: "A hosting platform: the author is not the host, and the same text is routinely republished elsewhere.",
  },
  { host: "substack.com", publisher: "Substack", ownership: "syndicator", provenance: "A hosting platform for independent writers." },
  {
    host: "prnewswire.com",
    publisher: "PR Newswire",
    ownership: "syndicator",
    provenance: "A press-release wire: the text originates with the issuer, not the host.",
  },
  { host: "businesswire.com", publisher: "Business Wire", ownership: "syndicator", provenance: "A press-release wire." },
  { host: "globenewswire.com", publisher: "GlobeNewswire", ownership: "syndicator", provenance: "A press-release wire." },
]);

export interface PublisherIdentity {
  readonly host: string;
  /** The organisation, or the registrable domain when the host is not listed. */
  readonly publisher: string;
  readonly ownership: PublisherOwnership | "unknown";
  readonly source: "registry" | "unknown";
  readonly version: number;
}

const bare = (hostname: string): string => hostname.toLowerCase().replace(/\.+$/, "");
/**
 * Public suffixes whose registrable domain is three labels, not two.
 *
 * The fallback label for an unlisted host is its registrable domain, and the
 * naive "last two labels" rule would make a shared public suffix an organisation:
 * `a.co.uk` and `b.co.uk` would be one "publisher" and genuinely independent UK
 * coverage would be suppressed as syndicated. Small and hand-reviewed on purpose —
 * a host under a suffix not listed here still falls back to its last two labels,
 * which is a label for comparison and not a claim of shared ownership.
 */
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "co.jp",
  "or.jp",
  "ne.jp",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "com.br",
  "com.cn",
  "co.in",
  "co.za",
  "com.mx",
  "co.kr",
  "com.sg",
  "co.il",
]);
/**
 * The registrable-ish domain, used only as a fallback label for an unlisted host.
 *
 * Suffix-aware so two hosts sharing nothing but a public suffix are not called one
 * organisation, and so `news.sky.co.uk` is labelled `sky.co.uk` — the name a reader
 * would give the publisher.
 */
const registrable = (hostname: string): string => {
  const parts = bare(hostname).split(".");
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo) && parts.length > 2 ? parts.slice(-3).join(".") : lastTwo;
};

/** Identify a host. An unlisted host is `unknown`, never assumed independent. */
export function publisherIdentity(hostname: string): PublisherIdentity {
  const host = bare(hostname);
  for (const entry of PUBLISHER_REGISTRY) {
    const matches = entry.host.startsWith("*.")
      ? host.endsWith(entry.host.slice(1)) && host.length > entry.host.length - 1
      : host === entry.host;
    if (matches)
      return { host, publisher: entry.publisher, ownership: entry.ownership, source: "registry", version: PUBLISHER_REGISTRY_VERSION };
  }
  return { host, publisher: registrable(host), ownership: "unknown", source: "unknown", version: PUBLISHER_REGISTRY_VERSION };
}

/**
 * Whether a host may contribute to *corroboration* at all.
 *
 * The strict reading — only a first-party `publisher` is independent — is
 * deliberately *not* what this function implements. A host nobody has reviewed is
 * `unknown`, which is "no evidence either way" rather than "known not to be
 * independent"; excluding it would make the registry a requirement rather than
 * evidence, and a deployment whose operators read hosts the registry has never
 * heard of could never satisfy corroboration. A *known* syndicator or aggregator,
 * by contrast, is excluded: it republishes or collects, and counting it would be
 * counting the same voice twice.
 *
 * Callers that mean "independent" rather than "may corroborate" should test
 * `publisherIdentity(host).ownership === "publisher"` directly, because the two
 * questions have different answers for an unreviewed host.
 */
export function mayCorroborate(hostname: string): boolean {
  const ownership = publisherIdentity(hostname).ownership;
  return ownership === "publisher" || ownership === "unknown";
}

/** Two hosts belonging to the same organisation are one publisher, not two sources. */
export function samePublisher(a: string, b: string): boolean {
  return publisherIdentity(a).publisher === publisherIdentity(b).publisher;
}
