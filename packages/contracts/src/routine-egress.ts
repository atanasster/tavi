import { z } from "zod";

/**
 * How a routine may reach the network.
 *
 * The default widens nothing: a routine fetches only
 * hosts the operator named. Every wider mode is an *operator edit* recorded in the
 * pinned revision — never a model decision — and each is refused unless the
 * address-level guard that backs it is present.
 *
 *  - `allowlist` — the revision's `permissions.allowedHosts` (the default).
 *  - `custom_hosts` — the same list, spelled explicitly so a reader can tell a
 *    deliberate widening from the default.
 *  - `primary_sources` — a **versioned curated policy** (below): named publisher
 *    and model-lab primary sources. It is a different thing from `custom_hosts`
 *    (the operator's own list), which is why the two are not one mode.
 *  - `open_web` — any *public* HTTPS host. Never unrestricted network access: it
 *    is retrieval of public pages, and the address guard refuses loopback,
 *    private, link-local (including the metadata service), CGNAT, multicast and
 *    reserved addresses on every hop.
 */
export const ROUTINE_NETWORK_MODES = ["allowlist", "primary_sources", "custom_hosts", "open_web"] as const;
export type RoutineNetworkMode = (typeof ROUTINE_NETWORK_MODES)[number];
export const RoutineNetworkModeSchema = z.enum(ROUTINE_NETWORK_MODES);

/**
 * The curated primary-source policy.
 *
 * Versioned and dated because it is *policy*: a reader must be able to tell which
 * list produced a grant. Membership is evidence that a host is a first-party
 * publisher, not proof of independence, and it is deliberately a small
 * hand-reviewed list rather than a wildcard over a hosting platform.
 *
 * This list answers an *egress* question — may the routine fetch this host? — and
 * is a different artifact from the publisher registry in `@tavi/runtime`
 * (`publisherIdentity`/`mayCorroborate`), which answers who published a host for
 * independence scoring. The two are reviewed separately and disagree where they
 * should: `arxiv.org` is admitted here because a preprint is primary material to
 * retrieve, while the registry classifies it an `aggregator` because arXiv did not
 * author or review the paper — so it may be fetched and may not corroborate.
 * Adding a host here never grants it independence, and a registry `publisher` that
 * is absent here (`reuters.com`) stays unfetchable in this mode.
 */
export const ROUTINE_PRIMARY_SOURCE_POLICY = {
  version: 1,
  reviewedAt: "2026-09-21",
  /** Exact hosts, or `*.suffix` forms, in the operator's own allowlist language. */
  hosts: [
    "openai.com",
    "*.openai.com",
    "anthropic.com",
    "*.anthropic.com",
    "blog.google",
    "deepmind.google",
    "ai.googleblog.com",
    "research.google",
    "developers.googleblog.com",
    "ai.meta.com",
    "about.fb.com",
    "blogs.microsoft.com",
    "azure.microsoft.com",
    "developer.nvidia.com",
    "blogs.nvidia.com",
    "mistral.ai",
    "cohere.com",
    "stability.ai",
    "huggingface.co",
    "arxiv.org",
    "github.blog",
    "aws.amazon.com",
    "cloud.google.com",
    "research.ibm.com",
  ],
} as const;

/**
 * Whether the `primary_sources` egress mode may fetch a host.
 *
 * The name says *host* on purpose: this is egress permission, not independence.
 * The independence question is `mayCorroborate`/`publisherIdentity` in
 * `@tavi/runtime`, which is a different, separately reviewed list — see the policy
 * comment above for why the two legitimately disagree.
 */
export function isPrimarySourceHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  return ROUTINE_PRIMARY_SOURCE_POLICY.hosts.some((entry) =>
    entry.startsWith("*.") ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : host === entry,
  );
}

/** A mode that widens beyond the operator's own list, and so needs the guard. */
export function isWideningNetworkMode(mode: RoutineNetworkMode): boolean {
  return mode === "primary_sources" || mode === "open_web";
}
