import { DOMAIN_SOURCE_TERMS_MAX_AGE_DAYS, type DomainSourceRecord } from "@tavi/contracts";

/**
 * The release check of a domain plugin's sources: run in its tests, it
 * lists what would ship wrong — terms not reviewed within
 * `DOMAIN_SOURCE_TERMS_MAX_AGE_DAYS`, a host the manifest's
 * `network.domains` does not reach, a credential the manifest does not
 * declare, a query, basic-auth or OAuth client key the worker cannot hold raw.
 */
export interface DomainManifestFacts {
  readonly networkDomains: readonly string[];
  /** The manifest's `config` keys of type `credential`. */
  readonly credentials: readonly string[];
  readonly rawSecrets: readonly string[];
}

/** Whether `host` is one `domain` names: exactly, or under a `*.` pattern; a port must match when either has one. */
export function domainCovers(domain: string, host: string): boolean {
  const [domainName = "", domainPort] = domain.toLowerCase().split(":");
  const [hostName = "", hostPort] = host.toLowerCase().split(":");
  if (domainPort !== undefined && domainPort !== hostPort) return false;
  if (domainPort === undefined && hostPort !== undefined) return false;
  if (domainName.startsWith("*.")) return hostName.endsWith(domainName.slice(1)) && hostName.length > domainName.length - 1;
  return domainName === hostName;
}

export function domainSourceProblems(records: readonly DomainSourceRecord[], manifest: DomainManifestFacts, today: string): string[] {
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  // A timestamp, or no date at all, would make every age NaN and every record pass.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isFinite(todayMs))
    throw new Error(`today is ${JSON.stringify(today)}: give the date as YYYY-MM-DD`);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) problems.push(`${record.id}: two records share this id`);
    seen.add(record.id);
    const ageDays = (todayMs - Date.parse(`${record.terms.reviewedAt}T00:00:00Z`)) / 86_400_000;
    if (ageDays > DOMAIN_SOURCE_TERMS_MAX_AGE_DAYS)
      problems.push(
        `${record.id}: terms last reviewed ${record.terms.reviewedAt}, over ${String(DOMAIN_SOURCE_TERMS_MAX_AGE_DAYS)} days ago`,
      );
    if (ageDays < 0) problems.push(`${record.id}: terms reviewed ${record.terms.reviewedAt}, after ${today}`);
    for (const host of record.hosts) {
      if (!manifest.networkDomains.some((domain) => domainCovers(domain, host)))
        problems.push(`${record.id}: ${host} is not in the manifest's network.domains`);
    }
    for (const key of record.credential ?? []) {
      if (!manifest.credentials.includes(key)) problems.push(`${record.id}: credential ${key} is not a credential setting of the manifest`);
      // An OAuth client's id and secret go out Base64-encoded in a token request's Basic auth, where the proxy cannot see a placeholder.
      if (
        (record.auth === "key-query" || record.auth === "key-basic" || record.auth === "oauth-client") &&
        !manifest.rawSecrets.includes(key)
      )
        problems.push(`${record.id}: ${record.auth} puts ${key} where the proxy cannot, so it must be in rawSecrets`);
    }
  }
  return problems;
}
